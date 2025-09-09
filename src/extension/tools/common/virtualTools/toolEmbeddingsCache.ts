/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Embedding, EmbeddingType, EmbeddingVector, IEmbeddingsComputer, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { IEmbeddingsCache } from '../../../../platform/embeddings/common/embeddingsIndex';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';

/**
 * Loads pre-computed tool embeddings from a JSON file
 */
class PreComputedEmbeddingsLoader implements IEmbeddingsCache {
	public embeddingType: EmbeddingType = EmbeddingType.text3small_512;

	private embeddings: { [key: string]: { embedding: EmbeddingVector } } | undefined = undefined;

	async getCache<T = { [key: string]: { embedding: EmbeddingVector } }>(): Promise<T | undefined> {
		return this.loadEmbeddings() as Promise<T>;
	}

	clearCache(): Promise<void> {
		this.embeddings = undefined;
		return Promise.resolve();
	}

	async loadEmbeddingsAsMap(): Promise<Map<string, Embedding>> {
		const embeddingsData = await this.loadEmbeddings();
		const embeddingsMap = new Map<string, Embedding>();

		if (embeddingsData) {
			for (const [key, value] of Object.entries(embeddingsData)) {
				embeddingsMap.set(key, {
					type: EmbeddingType.text3small_512,
					value: value.embedding
				});
			}
		}

		return embeddingsMap;
	}

	private async loadEmbeddings(): Promise<{ [key: string]: { embedding: EmbeddingVector } }> {
		if (!this.embeddings) {
			const embeddingsFile = (await import('./allRoolEmbeddings.json'));
			this.embeddings = {};
			for (const [key, value] of Object.entries(embeddingsFile.default)) {
				this.embeddings[key] = { embedding: value as unknown as EmbeddingVector };
			}
		}

		return this.embeddings;
	}
}

/**
 * Manages tool embeddings from both pre-computed cache and runtime computation
 */
export class ToolEmbeddingsComputer {
	private readonly preComputedLoader: PreComputedEmbeddingsLoader;
	private readonly embeddingsStore = new Map<string, Embedding>();
	private isInitialized = false;

	constructor(
		private readonly embeddingsComputer: IEmbeddingsComputer,
		private readonly embeddingType: EmbeddingType
	) {
		this.preComputedLoader = new PreComputedEmbeddingsLoader();
	}

	/**
	 * Legacy method name for backward compatibility
	 */
	public async retrieveSimilarEmbeddingsForAvailableTools(queryEmbedding: Embedding, availableToolNames: Set<string>, count: number, token: CancellationToken): Promise<string[]> {
		await this.ensureInitialized();
		await this.ensureToolEmbeddings(availableToolNames, token);

		if (token.isCancellationRequested) {
			return [];
		}

		const availableEmbeddings = this.getAvailableToolEmbeddings(availableToolNames);
		if (availableEmbeddings.length === 0) {
			return [];
		}

		const rankedEmbeddings = rankEmbeddings(queryEmbedding, availableEmbeddings, count);
		return rankedEmbeddings.map(x => x.value);
	}

	/**
	 * Ensures pre-computed embeddings are loaded into the store
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		const preComputedEmbeddings = await this.preComputedLoader.loadEmbeddingsAsMap();
		for (const [toolName, embedding] of preComputedEmbeddings) {
			this.embeddingsStore.set(toolName, embedding);
		}

		this.isInitialized = true;
	}

	/**
	 * Ensures all required tool embeddings are available (computing missing ones if needed)
	 */
	private async ensureToolEmbeddings(toolNames: Set<string>, token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}

		const missingTools: string[] = [];
		toolNames.forEach(t => {
			if (!this.embeddingsStore.has(t)) {
				missingTools.push(t);
			}
		});
		await this.computeMissingEmbeddings(missingTools, token);
	}


	/**
	 * Computes embeddings for missing tools and stores them
	 */
	private async computeMissingEmbeddings(missingToolNames: string[], token: CancellationToken): Promise<void> {
		if (token.isCancellationRequested || missingToolNames.length === 0) {
			return;
		}

		const computedEmbeddings = await this.computeEmbeddingsForTools(missingToolNames, token);
		if (computedEmbeddings) {
			for (const [toolName, embedding] of computedEmbeddings) {
				this.embeddingsStore.set(toolName, embedding);
			}
		}
	}

	/**
	 * Computes embeddings for a list of tool names
	 */
	private async computeEmbeddingsForTools(toolNames: string[], token: CancellationToken): Promise<[string, Embedding][] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const embeddings = await this.embeddingsComputer.computeEmbeddings(this.embeddingType, toolNames, {}, token);

		if (embeddings?.values.length === 0 || embeddings?.values.length !== toolNames.length) {
			return undefined;
		}

		return toolNames.map((name, index) => [name, embeddings.values[index]]);
	}

	/**
	 * Gets embeddings for available tools as an array suitable for ranking
	 */
	private getAvailableToolEmbeddings(availableToolNames: Set<string>): ReadonlyArray<readonly [string, Embedding]> {
		const result: [string, Embedding][] = [];

		for (const toolName of availableToolNames) {
			const embedding = this.embeddingsStore.get(toolName);
			if (embedding) {
				result.push([toolName, embedding]);
			}
		}

		return result;
	}
}