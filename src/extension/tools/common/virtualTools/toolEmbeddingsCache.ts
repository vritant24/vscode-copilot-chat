/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Embedding, EmbeddingType, EmbeddingVector, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { IEmbeddingsCache } from '../../../../platform/embeddings/common/embeddingsIndex';

class ToolEmbeddingsCache implements IEmbeddingsCache {
	public embeddingType: EmbeddingType = EmbeddingType.text3small_512;

	private embeddings: { [key: string]: { embedding: EmbeddingVector } } | undefined = undefined;
	async getCache<T = { [key: string]: { embedding: EmbeddingVector } }>(): Promise<T | undefined> {
		return this.getEmbeddings() as Promise<T>;
	}

	clearCache(): Promise<void> {
		return Promise.resolve();
	}

	private async getEmbeddings(): Promise<{ [key: string]: { embedding: EmbeddingVector } }> {
		if (!this.embeddings) {
			const embeddingsFile = (await import('./allRoolEmbeddings'));
			this.embeddings = {};
			for (const [key, value] of Object.entries(embeddingsFile.embeddingsMap)) {
				this.embeddings[key] = { embedding: value };
			}
		}

		return this.embeddings;
	}
}

export class ToolEmbeddingsComputer {
	private readonly toolEmbeddingsCache: ToolEmbeddingsCache;

	constructor() {
		this.toolEmbeddingsCache = new ToolEmbeddingsCache();
	}

	public async computeSimilarity(queryEmbedding: Embedding): Promise<string[]> {
		const tools = await this.getToolEmbeddingsArray();
		if (!tools || tools.length === 0) {
			return [];
		}

		const rankedEmbeddings = rankEmbeddings(queryEmbedding, tools, 10);
		return rankedEmbeddings.map(x => x.value[0]);
	}

	private toolEmbeddingsArray: ReadonlyArray<readonly [string, Embedding]> | undefined = undefined;
	private async getToolEmbeddingsArray(): Promise<ReadonlyArray<readonly [string, Embedding]>> {
		if (!this.toolEmbeddingsArray) {
			const arr = [];
			// Load the embeddings from the cache
			const embeddings = await this.toolEmbeddingsCache.getCache();
			if (embeddings) {
				for (const [key, value] of Object.entries(embeddings)) {
					arr.push([key, value.embedding]);
				}
				this.toolEmbeddingsArray = arr as unknown as ReadonlyArray<readonly [string, Embedding]>;
			} else {
				this.toolEmbeddingsArray = [];
			}
		}
		return this.toolEmbeddingsArray;
	}
}