/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IHTMLRouter } from '@vscode/prompt-tsx';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ChatRequestScheme, ILoggedElementInfo, ILoggedRequestInfo, ILoggedToolCall, IRequestLogger, LoggedInfo, LoggedInfoKind, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { assertNever } from '../../../util/vs/base/common/assert';
import { Disposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { LRUCache } from '../../../util/vs/base/common/map';
import { isDefined } from '../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequest } from '../../../vscodeTypes';
import { IExtensionContribution } from '../../common/contributions';

const showHtmlCommand = 'vscode.copilot.chat.showRequestHtmlItem';
const exportLogItemCommand = 'github.copilot.chat.debug.exportLogItem';
const exportPromptArchiveCommand = 'github.copilot.chat.debug.exportPromptArchive';
const exportPromptLogsAsJsonCommand = 'github.copilot.chat.debug.exportPromptLogsAsJson';
const exportAllPromptLogsAsJsonCommand = 'github.copilot.chat.debug.exportAllPromptLogsAsJson';
const saveCurrentMarkdownCommand = 'github.copilot.chat.debug.saveCurrentMarkdown';

export class RequestLogTree extends Disposable implements IExtensionContribution {
	readonly id = 'requestLogTree';
	private readonly chatRequestProvider: ChatRequestProvider;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IRequestLogger requestLogger: IRequestLogger,
	) {
		super();
		this.chatRequestProvider = this._register(instantiationService.createInstance(ChatRequestProvider));
		this._register(vscode.window.registerTreeDataProvider('copilot-chat', this.chatRequestProvider));

		let server: RequestServer | undefined;

		const getExportableLogEntries = (treeItem: ChatPromptItem): LoggedInfo[] => {
			if (!treeItem || !treeItem.children) {
				return [];
			}

			const logEntries = treeItem.children.map(child => {
				if (child instanceof ChatRequestItem || child instanceof ToolCallItem || child instanceof ChatElementItem) {
					return child.info;
				}
				return undefined; // Skip non-loggable items
			}).filter(isDefined);

			return logEntries;
		};

		// Helper method to process log entries for a single prompt
		const preparePromptLogsAsJson = async (treeItem: ChatPromptItem): Promise<any> => {
			const logEntries = getExportableLogEntries(treeItem);

			if (logEntries.length === 0) {
				return;
			}

			const promptLogs: any[] = [];

			for (const logEntry of logEntries) {
				try {
					promptLogs.push(await logEntry.toJSON());
				} catch (error) {
					// If we can't get content for this entry, add an error object
					promptLogs.push({
						id: logEntry.id,
						kind: 'error',
						error: error?.toString() || 'Unknown error',
						timestamp: new Date().toISOString()
					});
				}
			}

			return {
				prompt: treeItem.request.prompt,
				promptId: treeItem.id,
				hasSeen: treeItem.hasSeen,
				logCount: promptLogs.length,
				logs: promptLogs
			};
		};

		this._register(vscode.commands.registerCommand(showHtmlCommand, async (elementId: string) => {
			if (!server) {
				server = this._register(new RequestServer());
			}

			const req = requestLogger.getRequests().find(r => r.kind === LoggedInfoKind.Element && r.id === elementId);
			if (!req) {
				return;
			}

			const address = await server.addRouter(req as ILoggedElementInfo);
			await vscode.commands.executeCommand('simpleBrowser.show', address);
		}));

		this._register(vscode.commands.registerCommand(exportLogItemCommand, async (treeItem: TreeItem) => {
			if (!treeItem || !treeItem.id) {
				return;
			}

			let logEntry: LoggedInfo;

			if (treeItem instanceof ChatPromptItem) {
				// ChatPromptItem doesn't represent a single log entry
				vscode.window.showWarningMessage('Cannot export chat prompt item. Please select a specific request, tool call, or element.');
				return;
			} else if (treeItem instanceof ChatRequestItem || treeItem instanceof ToolCallItem || treeItem instanceof ChatElementItem) {
				logEntry = treeItem.info;
			} else {
				vscode.window.showErrorMessage('Unable to determine log entry ID for this item.');
				return;
			}

			// Check if this entry type supports markdown export
			if (logEntry.kind === LoggedInfoKind.Element) {
				vscode.window.showWarningMessage('Element entries cannot be exported as markdown. They contain HTML content that can be viewed in the browser.');
				return;
			}

			// Generate a default filename based on the entry type and id
			let defaultFilename: string;
			switch (logEntry.kind) {
				case LoggedInfoKind.Request: {
					const requestEntry = logEntry as ILoggedRequestInfo;
					const debugName = requestEntry.entry.debugName.replace(/\W/g, '_');
					defaultFilename = `${debugName}_${logEntry.id}.copilotmd`;
					break;
				}
				case LoggedInfoKind.ToolCall: {
					const toolEntry = logEntry as ILoggedToolCall;
					const toolName = toolEntry.name.replace(/\W/g, '_');
					defaultFilename = `tool_${toolName}_${logEntry.id}.copilotmd`;
					break;
				}
			}

			if (!defaultFilename) {
				return;
			}

			// Show save dialog
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: {
					'Copilot Markdown': ['copilotmd'],
					'Markdown': ['md'],
					'All Files': ['*']
				},
				title: 'Export Log Entry'
			});

			if (!saveUri) {
				return; // User cancelled
			}

			try {
				// Get the content using the virtual document URI
				const virtualUri = vscode.Uri.parse(ChatRequestScheme.buildUri({ kind: 'request', id: logEntry.id }));
				const document = await vscode.workspace.openTextDocument(virtualUri);
				const content = document.getText();

				// Write to the selected file
				await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

				// Show success message with option to open the file
				const openAction = 'Open File';
				const result = await vscode.window.showInformationMessage(
					`Successfully exported to ${saveUri.fsPath}`,
					openAction
				);

				if (result === openAction) {
					await vscode.commands.executeCommand('vscode.open', saveUri);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export log entry: ${error}`);
			}
		}));

		// Save the currently opened chat log (ccreq:*.copilotmd) to a file
		this._register(vscode.commands.registerCommand(saveCurrentMarkdownCommand, async (...args: any[]) => {
			// Accept resource from menu invocation (editor/title passes the resource)
			let resource: vscode.Uri | undefined;
			const first = args?.[0];
			if (first instanceof vscode.Uri) {
				resource = first;
			} else if (first && typeof first === 'object') {
				// Some menu invocations pass { resource: Uri }
				const candidate = (first as { resource?: vscode.Uri }).resource;
				if (candidate instanceof vscode.Uri) {
					resource = candidate;
				}
			}

			// Fallback to the active editor's document
			resource ??= vscode.window.activeTextEditor?.document.uri;
			if (!resource) {
				vscode.window.showWarningMessage('No document is active to save.');
				return;
			}

			if (resource.scheme !== ChatRequestScheme.chatRequestScheme) {
				vscode.window.showWarningMessage('This command only works for Copilot request documents.');
				return;
			}

			// Determine a default filename from the virtual URI
			const parseResult = ChatRequestScheme.parseUri(resource.toString());
			const defaultBase = parseResult && parseResult.data.kind === 'request' ? parseResult.data.id : 'latestrequest';
			const defaultFilename = `${defaultBase}.md`;

			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: {
					'Markdown': ['md'],
					'Copilot Markdown': ['copilotmd'],
					'All Files': ['*']
				},
				title: 'Save Markdown As'
			});

			if (!saveUri) {
				return; // User cancelled
			}

			try {
				// Read the text from the virtual document URI explicitly
				const doc = await vscode.workspace.openTextDocument(resource);
				await vscode.workspace.fs.writeFile(saveUri, Buffer.from(doc.getText(), 'utf8'));

				const openAction = 'Open File';
				const result = await vscode.window.showInformationMessage(
					`Successfully saved to ${saveUri.fsPath}`,
					openAction
				);

				if (result === openAction) {
					await vscode.commands.executeCommand('vscode.open', saveUri);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to save markdown: ${error}`);
			}
		}));

		this._register(vscode.commands.registerCommand(exportPromptArchiveCommand, async (treeItem: ChatPromptItem) => {
			const logEntries = getExportableLogEntries(treeItem);

			if (logEntries.length === 0) {
				vscode.window.showInformationMessage('No exportable entries found in this prompt.');
				return;
			}

			// Generate a default filename based on the prompt
			const promptText = treeItem.request.prompt.replace(/\W/g, '_').substring(0, 50);
			const defaultFilename = `${promptText}_exports.tar.gz`;

			// Show save dialog
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: {
					'Tar Archive': ['tar.gz', 'tgz'],
					'All Files': ['*']
				},
				title: 'Export Prompt Archive'
			});

			if (!saveUri) {
				return; // User cancelled
			}

			try {
				// Create temporary directory for files
				const tempDir = path.join(os.tmpdir(), `vscode-copilot-export-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
				await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir));

				const filesToArchive: string[] = [];

				// Export each child to a temporary file
				for (const logEntry of logEntries) {
					// Generate filename for this entry
					let filename: string;
					switch (logEntry.kind) {
						case LoggedInfoKind.Request: {
							const requestEntry = logEntry as ILoggedRequestInfo;
							const debugName = requestEntry.entry.debugName.replace(/\W/g, '_');
							filename = `${debugName}_${logEntry.id}.copilotmd`;
							break;
						}
						case LoggedInfoKind.ToolCall: {
							const toolEntry = logEntry as ILoggedToolCall;
							const toolName = toolEntry.name.replace(/\W/g, '_');
							filename = `tool_${toolName}_${logEntry.id}.copilotmd`;
							break;
						}
						default:
							continue;
					}

					// Get the content and write to temporary file
					const virtualUri = vscode.Uri.parse(ChatRequestScheme.buildUri({ kind: 'request', id: logEntry.id }));
					const document = await vscode.workspace.openTextDocument(virtualUri);
					const content = document.getText();

					const tempFilePath = path.join(tempDir, filename);
					await vscode.workspace.fs.writeFile(vscode.Uri.file(tempFilePath), Buffer.from(content, 'utf8'));
					filesToArchive.push(tempFilePath);
				}

				if (filesToArchive.length > 0) {
					// Create tar.gz archive
					await tar.create(
						{
							gzip: true,
							file: saveUri.fsPath,
							cwd: tempDir
						},
						filesToArchive.map(f => path.basename(f))
					);

					// Clean up temporary files
					for (const filePath of filesToArchive) {
						await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
					}
					await vscode.workspace.fs.delete(vscode.Uri.file(tempDir));

					// Show success message with option to reveal the file
					const revealAction = 'Reveal in Explorer';
					const result = await vscode.window.showInformationMessage(
						`Successfully exported ${filesToArchive.length} entries to ${saveUri.fsPath}`,
						revealAction
					);

					if (result === revealAction) {
						await vscode.commands.executeCommand('revealFileInOS', saveUri);
					}
				} else {
					vscode.window.showWarningMessage('No valid entries could be exported.');
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export prompt archive: ${error}`);
			}
		}));

		this._register(vscode.commands.registerCommand(exportPromptLogsAsJsonCommand, async (treeItem: ChatPromptItem) => {
			const promptObject = await preparePromptLogsAsJson(treeItem);
			if (!promptObject) {
				vscode.window.showWarningMessage('No exportable entries found for this prompt.');
				return;
			}

			// Generate a default filename based on the prompt
			const promptText = treeItem.request.prompt.replace(/\W/g, '_').substring(0, 50);
			const defaultFilename = `${promptText}_logs.chatreplay.json`;

			// Show save dialog
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
				filters: {
					'JSON': ['json'],
					'All Files': ['*']
				},
				title: 'Export Prompt Logs as JSON'
			});

			if (!saveUri) {
				return; // User cancelled
			}

			try {
				// Convert to JSON
				const finalContent = JSON.stringify(promptObject, null, 2);

				// Write to the selected file
				await vscode.workspace.fs.writeFile(saveUri, Buffer.from(finalContent, 'utf8'));

				// Show success message with option to reveal the file
				const revealAction = 'Reveal in Explorer';
				const openAction = 'Open File';
				const result = await vscode.window.showInformationMessage(
					`Successfully exported prompt with ${promptObject.logCount} log entries to ${saveUri.fsPath}`,
					revealAction,
					openAction
				);

				if (result === revealAction) {
					await vscode.commands.executeCommand('revealFileInOS', saveUri);
				} else if (result === openAction) {
					await vscode.commands.executeCommand('vscode.open', saveUri);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export prompt logs as JSON: ${error}`);
			}
		}));

		this._register(vscode.commands.registerCommand(exportAllPromptLogsAsJsonCommand, async (savePath?: string) => {
			// Build the tree structure to get all chat prompt items
			const allTreeItems = await this.chatRequestProvider.getChildren();

			if (!allTreeItems || allTreeItems.length === 0) {
				vscode.window.showInformationMessage('No chat prompts found to export.');
				return;
			}

			// Filter to get only ChatPromptItem instances
			const chatPromptItems = allTreeItems.filter((item): item is ChatPromptItem => item instanceof ChatPromptItem);

			if (chatPromptItems.length === 0) {
				vscode.window.showInformationMessage('No chat prompts found to export.');
				return;
			}

			let saveUri: vscode.Uri;

			if (savePath && typeof savePath === 'string') {
				// Use provided path
				saveUri = vscode.Uri.file(savePath);
			} else {
				// Generate a default filename based on current timestamp
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
				const defaultFilename = `copilot_all_prompts_${timestamp}.chatreplay.json`;

				// Show save dialog
				const dialogResult = await vscode.window.showSaveDialog({
					defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultFilename)),
					filters: {
						'JSON': ['json'],
						'All Files': ['*']
					},
					title: 'Export All Prompt Logs as JSON'
				});

				if (!dialogResult) {
					return; // User cancelled
				}
				saveUri = dialogResult;
			}

			try {
				const allPromptsContent: any[] = [];
				let totalLogEntries = 0;

				// Process each chat prompt item using the shared function
				for (const chatPromptItem of chatPromptItems) {
					// Use the shared processing function
					const promptObject = await preparePromptLogsAsJson(chatPromptItem);
					if (promptObject) {
						allPromptsContent.push(promptObject);
						totalLogEntries += promptObject.logCount;
					}
				}

				// Combine all content as JSON
				const finalContent = JSON.stringify({
					exportedAt: new Date().toISOString(),
					totalPrompts: allPromptsContent.length,
					totalLogEntries: totalLogEntries,
					prompts: allPromptsContent
				}, null, 2);

				// Write to the selected file
				await vscode.workspace.fs.writeFile(saveUri, Buffer.from(finalContent, 'utf8'));

				// Show success message with option to reveal the file
				const revealAction = 'Reveal in Explorer';
				const openAction = 'Open File';
				const result = await vscode.window.showInformationMessage(
					`Successfully exported ${allPromptsContent.length} prompts with ${totalLogEntries} log entries to ${saveUri.fsPath}`,
					revealAction,
					openAction
				);

				if (result === revealAction) {
					await vscode.commands.executeCommand('revealFileInOS', saveUri);
				} else if (result === openAction) {
					await vscode.commands.executeCommand('vscode.open', saveUri);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to export all prompt logs as JSON: ${error}`);
			}
		}));
	}
}


/**
 * Servers that shows logged request html for the simple browser. Doing this
 * is annoying, but the markdown renderer is limited and doesn't show full HTML,
 * and the simple browser extension can't render internal or `file://` URIs.
 *
 * Note that we don't need secret tokens or anything at this point because the
 * server is read-only and does not advertise any CORS headers.
 */
class RequestServer extends Disposable {
	public port: Promise<number>;
	private routers = new LRUCache<string, IHTMLRouter>(10);

	constructor() {
		super();

		const server = createServer((req, res) => {
			for (const [key, router] of this.routers) {
				if (router.route(req, res)) {
					this.routers.get(key); // LRU touch
					return;
				}
			}

			res.statusCode = 404;
			res.end('Not Found');
		});

		this.port = new Promise<number>((resolve, reject) => {
			server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)).on('error', reject);
		});

		this._register(toDisposable(() => server.close()));
	}

	async addRouter(info: ILoggedElementInfo) {
		const prev = this.routers.get(info.id);
		if (prev) {
			return prev.address;
		}

		const port = await this.port;
		const router = info.trace.serveRouter(`http://127.0.0.1:${port}`);
		this.routers.set(info.id, router);
		return router.address;
	}
}

type TreeItem = ChatPromptItem | ChatRequestItem | ChatElementItem | ToolCallItem;

class ChatRequestProvider extends Disposable implements vscode.TreeDataProvider<TreeItem> {
	private readonly filters: LogTreeFilters;

	constructor(
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.filters = this._register(instantiationService.createInstance(LogTreeFilters));
		this._register(new LogTreeFilterCommands(this.filters));
		this._register(this.requestLogger.onDidChangeRequests(() => this._onDidChangeTreeData.fire()));
		this._register(this.filters.onDidChangeFilters(() => this._onDidChangeTreeData.fire()));
	}

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
	onDidChangeTreeData = this._onDidChangeTreeData.event;

	getTreeItem(element: TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}

	getChildren(element?: TreeItem | undefined): vscode.ProviderResult<TreeItem[]> {
		if (element instanceof ChatPromptItem) {
			return element.children;
		} else if (element) {
			return [];
		} else {
			let lastPrompt: ChatPromptItem | undefined;
			const result: (ChatPromptItem | TreeChildItem)[] = [];
			const seen = new Set<ChatRequest | undefined>();

			for (const r of this.requestLogger.getRequests()) {
				const item = this.logToTreeItem(r);
				if (r.chatRequest !== lastPrompt?.request) {
					if (lastPrompt) {
						result.push(lastPrompt);
					}
					lastPrompt = r.chatRequest ? ChatPromptItem.create(r, r.chatRequest, seen.has(r.chatRequest)) : undefined;
					seen.add(r.chatRequest);
				}

				if (lastPrompt) {
					if (!lastPrompt.children.find(c => c.id === item.id)) {
						lastPrompt.children.push(item);
					}
					if (!lastPrompt.children.find(c => c.id === item.id)) {
						lastPrompt.children.push(item);
					}
				} else {
					result.push(item);
				}
			}

			if (lastPrompt) {
				result.push(lastPrompt);
			}

			return result.map(r => {
				if (r instanceof ChatPromptItem) {
					return r.withFilteredChildren(child => this.filters.itemIncluded(child));
				}

				return r;
			})
				.filter(r => this.filters.itemIncluded(r));
		}
	}

	private logToTreeItem(r: LoggedInfo): TreeChildItem {
		switch (r.kind) {
			case LoggedInfoKind.Request:
				return new ChatRequestItem(r);
			case LoggedInfoKind.Element:
				return new ChatElementItem(r);
			case LoggedInfoKind.ToolCall:
				return new ToolCallItem(r);
			default:
				assertNever(r);
		}
	}
}

type TreeChildItem = ChatRequestItem | ChatElementItem | ToolCallItem;

class ChatPromptItem extends vscode.TreeItem {
	private static readonly ids = new WeakMap<LoggedInfo, ChatPromptItem>();
	override readonly contextValue = 'chatprompt';
	public children: TreeChildItem[] = [];
	public override id: string | undefined;

	public static create(info: LoggedInfo, request: ChatRequest, hasSeen: boolean) {
		const existing = ChatPromptItem.ids.get(info);
		if (existing) {
			return existing;
		}

		const item = new ChatPromptItem(request, hasSeen);
		item.id = info.id + '-prompt';
		ChatPromptItem.ids.set(info, item);
		return item;
	}

	protected constructor(public readonly request: ChatRequest, public readonly hasSeen: boolean) {
		super(request.prompt, vscode.TreeItemCollapsibleState.Expanded);
		this.iconPath = new vscode.ThemeIcon('comment');
		if (hasSeen) {
			this.description = '(Continued...)';
		}
	}

	public withFilteredChildren(filter: (child: TreeChildItem) => boolean): ChatPromptItem {
		const item = new ChatPromptItem(this.request, this.hasSeen);
		item.children = this.children.filter(filter);
		return item;
	}
}

class ToolCallItem extends vscode.TreeItem {
	public override id: string;
	override readonly contextValue = 'toolcall';
	constructor(
		readonly info: ILoggedToolCall
	) {
		// todo@connor4312: we should have flags from the renderer whether it dropped any messages and indicate that here
		super(info.name, vscode.TreeItemCollapsibleState.None);
		this.id = `${info.id}_${info.time}`;
		this.description = info.args === undefined ? '' : typeof info.args === 'string' ? info.args : JSON.stringify(info.args);
		this.command = {
			command: 'vscode.open',
			title: '',
			arguments: [vscode.Uri.parse(ChatRequestScheme.buildUri({ kind: 'request', id: info.id }))]
		};
		this.iconPath = new vscode.ThemeIcon('tools');
	}
}

class ChatElementItem extends vscode.TreeItem {
	public override readonly id?: string;

	constructor(
		readonly info: ILoggedElementInfo
	) {
		// todo@connor4312: we should have flags from the renderer whether it dropped any messages and indicate that here
		super(`<${info.name}/>`, vscode.TreeItemCollapsibleState.None);
		this.id = info.id;
		this.description = `${info.tokens} tokens`;
		this.command = { command: showHtmlCommand, title: '', arguments: [info.id] };
		this.iconPath = new vscode.ThemeIcon('code');
	}
}

class ChatRequestItem extends vscode.TreeItem {
	public override id: string;
	override readonly contextValue = 'request';
	constructor(
		readonly info: ILoggedRequestInfo
	) {
		super(info.entry.debugName, vscode.TreeItemCollapsibleState.None);
		this.id = info.id;

		if (info.entry.type === LoggedRequestKind.MarkdownContentRequest) {
			this.iconPath = info.entry.icon === undefined ? undefined : new vscode.ThemeIcon(info.entry.icon.id);
			const startTimeStr = new Date(info.entry.startTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			this.description = startTimeStr;
		} else {
			const durationMs = info.entry.endTime.getTime() - info.entry.startTime.getTime();
			const timeStr = `${durationMs.toLocaleString('en-US')}ms`;
			const startTimeStr = info.entry.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			const tokensStr = info.entry.type === LoggedRequestKind.ChatMLSuccess && info.entry.usage ? `${info.entry.usage.prompt_tokens.toLocaleString('en-US')}tks` : '';
			const tokensStrPart = tokensStr ? `[${tokensStr}] ` : '';
			this.description = `${tokensStrPart}[${timeStr}] [${startTimeStr}]`;

			this.iconPath = info.entry.type === LoggedRequestKind.ChatMLSuccess || info.entry.type === LoggedRequestKind.CompletionSuccess ? undefined : new vscode.ThemeIcon('error');
			this.tooltip = `${info.entry.type === LoggedRequestKind.ChatMLCancelation ? 'cancelled' : info.entry.result.type}
	${info.entry.chatEndpoint.model}
	${timeStr}
	${startTimeStr}`;
			if (tokensStr) {
				this.tooltip += `\n\t${tokensStr}`;
			}
		}
		this.command = {
			command: 'vscode.open',
			title: '',
			arguments: [vscode.Uri.parse(ChatRequestScheme.buildUri({ kind: 'request', id: info.id }))]
		};
		this.iconPath ??= new vscode.ThemeIcon('copilot');
	}
}

class LogTreeFilters extends Disposable {
	private _elementsShown = true;
	private _toolsShown = true;
	private _nesRequestsShown = true;

	private readonly _onDidChangeFilters = new vscode.EventEmitter<void>();
	readonly onDidChangeFilters = this._onDidChangeFilters.event;

	constructor(
		@IVSCodeExtensionContext private readonly vscodeExtensionContext: IVSCodeExtensionContext,
	) {
		super();

		this.setElementsShown(!vscodeExtensionContext.workspaceState.get(this.getStorageKey('elements')));
		this.setToolsShown(!vscodeExtensionContext.workspaceState.get(this.getStorageKey('tools')));
		this.setNesRequestsShown(!vscodeExtensionContext.workspaceState.get(this.getStorageKey('nesRequests')));
	}

	private getStorageKey(name: string): string {
		return `github.copilot.chat.debug.${name}Hidden`;
	}

	setElementsShown(value: boolean) {
		this._elementsShown = value;
		this.setShown('elements', this._elementsShown);
	}

	setToolsShown(value: boolean) {
		this._toolsShown = value;
		this.setShown('tools', this._toolsShown);
	}

	setNesRequestsShown(value: boolean) {
		this._nesRequestsShown = value;
		this.setShown('nesRequests', this._nesRequestsShown);
	}

	itemIncluded(item: TreeItem): boolean {
		if (item instanceof ChatPromptItem) {
			return true; // Always show chat prompt items
		} else if (item instanceof ChatElementItem) {
			return this._elementsShown;
		} else if (item instanceof ToolCallItem) {
			return this._toolsShown;
		} else if (item instanceof ChatRequestItem) {
			// Check if this is a NES request
			if (this.isNesRequest(item)) {
				return this._nesRequestsShown;
			}
		}

		return true;
	}

	private isNesRequest(item: ChatRequestItem): boolean {
		const debugName = item.info.entry.debugName.toLowerCase();
		return debugName.startsWith('nes |') || debugName === 'xtabprovider';
	}

	private setShown(name: string, value: boolean): void {
		vscode.commands.executeCommand('setContext', `github.copilot.chat.debug.${name}Hidden`, !value);
		this.vscodeExtensionContext.workspaceState.update(this.getStorageKey(name), !value);
		this._onDidChangeFilters.fire();
	}
}

class LogTreeFilterCommands extends Disposable {
	constructor(filters: LogTreeFilters) {
		super();

		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.showElements', () => filters.setElementsShown(true)));
		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.hideElements', () => filters.setElementsShown(false)));
		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.showTools', () => filters.setToolsShown(true)));
		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.hideTools', () => filters.setToolsShown(false)));
		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.showNesRequests', () => filters.setNesRequestsShown(true)));
		this._register(vscode.commands.registerCommand('github.copilot.chat.debug.hideNesRequests', () => filters.setNesRequestsShown(false)));
	}
}