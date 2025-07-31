/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ITelemetryFileLogger } from '../common/fileLogger';

export class NodeTelemetryFileLogger implements ITelemetryFileLogger {
	private readonly filePath: string;
	constructor() {
		this.filePath = "C:\\repos\\vscode-copilot-chat\\telemetry.log";
	}

	async logLine(line: string): Promise<void> {

		try {
			const logLine = line + '\n';
			const existingContent = await this._readExistingContent();
			const newContent = existingContent + logLine;

			await writeFileSync(this.filePath, Buffer.from(newContent, 'utf8'));
		} catch (error) {
			console.error('TelemetryFileLogger: Error writing log entry:', error);
		}
	}

	private async _readExistingContent(): Promise<string> {
		try {
			if (existsSync(this.filePath)) {
				const content = readFileSync(this.filePath);
				return content.toString();
			}
		} catch (error) {
			// File doesn't exist yet, which is fine
		}
		return '';
	}

	dispose(): void {
		// No cleanup needed for simplified logger
	}
}