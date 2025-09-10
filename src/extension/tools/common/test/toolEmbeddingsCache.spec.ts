/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { Embedding, EmbeddingType, rankEmbeddings } from '../../../../platform/embeddings/common/embeddingsComputer';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { ToolEmbeddingsComputer } from '../virtualTools/toolEmbeddingsCache';

vi.mock('../../../../platform/embeddings/common/embeddingsComputer', async (importActual) => {
	const actual = await importActual<typeof import('../../../../platform/embeddings/common/embeddingsComputer')>();
	return {
		...actual,
		rankEmbeddings: vi.fn()
	};
});

const rankEmbeddingMock = rankEmbeddings as Mock<typeof rankEmbeddings>;

describe('ToolEmbeddingsComputer', () => {
	const token = CancellationToken.None;

	function createToolEmbeddingComputer(embeddings: Map<string, Embedding>, embeddingsComputer = { _serviceBrand: undefined, computeEmbeddings: vi.fn() }) {
		// Mock PreComputedToolEmbeddingsCache
		const mockEmbeddingsCache = {
			embeddingType: EmbeddingType.text3small_512,
			getEmbeddings: vi.fn().mockResolvedValue(embeddings)
		};

		return new ToolEmbeddingsComputer(
			mockEmbeddingsCache as any,
			embeddingsComputer as any,
			EmbeddingType.text3small_512,
			new TestLogService()
		);
	}

	function createMockEmbedding(value: number[]): Embedding {
		return {
			type: EmbeddingType.text3small_512,
			value
		};
	}

	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('should return empty array when no tools are available', async () => {
		const availableTools = new Set<string>();
		const queryEmbedding = createMockEmbedding([1, 0, 0]);

		rankEmbeddingMock.mockReturnValue([]);

		const computer = createToolEmbeddingComputer(new Map());

		const result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);

		expect(result).toEqual([]);
	});

	it('should return tool names for available tools', async () => {
		const availableTools = new Set(['tool1', 'tool2']);
		const queryEmbedding = createMockEmbedding([1, 0, 0]);

		// Mock rankEmbeddings to return results in order
		rankEmbeddingMock.mockReturnValue([
			{ value: 'tool1', distance: { value: 0.5, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool2', distance: { value: 0.8, embeddingType: EmbeddingType.text3small_512 } }
		]);

		const computer = createToolEmbeddingComputer(new Map([
			['tool1', createMockEmbedding([0.9, 0.1, 0])],
			['tool2', createMockEmbedding([0.8, 0.2, 0])],
			['tool3', createMockEmbedding([0, 1, 0])]
		]));

		const result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toBe('tool1');
		expect(result[1]).toBe('tool2');
	});

	it('should respect count parameter', async () => {
		const availableTools = new Set(['tool1', 'tool2', 'tool3']);
		const queryEmbedding = createMockEmbedding([1, 0, 0]);

		// Mock rankEmbeddings to return limited results based on count
		rankEmbeddingMock.mockReturnValue([
			{ value: 'tool1', distance: { value: 0.3, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool2', distance: { value: 0.6, embeddingType: EmbeddingType.text3small_512 } }
		]);

		const computer = createToolEmbeddingComputer(new Map([
			['tool1', createMockEmbedding([0.9, 0.1, 0])],
			['tool2', createMockEmbedding([0.8, 0.2, 0])],
			['tool3', createMockEmbedding([0, 1, 0])]
		]));

		const result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			2, // Limit to 2 results
			token
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toBe('tool1');
		expect(result[1]).toBe('tool2');
	});

	it('should maintain order from ranking function', async () => {
		const availableTools = new Set(['tool1', 'tool2', 'tool3']);
		const queryEmbedding = createMockEmbedding([1, 0, 0]);

		// Mock rankEmbeddings to return specific order (tool3, tool1, tool2)
		rankEmbeddingMock.mockReturnValue([
			{ value: 'tool3', distance: { value: 0.1, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool1', distance: { value: 0.5, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool2', distance: { value: 0.9, embeddingType: EmbeddingType.text3small_512 } }
		]);

		const computer = createToolEmbeddingComputer(new Map([
			['tool1', createMockEmbedding([0.9, 0.1, 0])],
			['tool2', createMockEmbedding([0.8, 0.2, 0])],
			['tool3', createMockEmbedding([0, 1, 0])]
		]));

		const result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);

		expect(result).toHaveLength(3);
		expect(result[0]).toBe('tool3');
		expect(result[1]).toBe('tool1');
		expect(result[2]).toBe('tool2');
	});

	it('should handle partial cache hits and compute missing embeddings', async () => {
		const availableTools = new Set(['tool1', 'tool2', 'tool3', 'tool4']);
		const queryEmbedding = createMockEmbedding([1, 0, 0]);
		rankEmbeddingMock.mockReturnValue([
			{ value: 'tool1', distance: { value: 0.4, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool4', distance: { value: 0.7, embeddingType: EmbeddingType.text3small_512 } }
		]);

		// Create mock embeddings computer that returns embeddings for missing tools
		const computeEmbeddingsMock = vi.fn().mockResolvedValue({
			values: [
				createMockEmbedding([0.7, 0.3, 0]), // tool3
				createMockEmbedding([0.5, 0.5, 0])  // tool4
			]
		});
		const embeddingsComputerMock = { _serviceBrand: undefined, computeEmbeddings: computeEmbeddingsMock };

		const computer = createToolEmbeddingComputer(new Map([
			['tool1', createMockEmbedding([0.9, 0.1, 0])],
			['tool2', createMockEmbedding([0.8, 0.2, 0])]
		]), embeddingsComputerMock);

		const result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe('tool1');
		expect(result[1]).toBe('tool4');
		expect(computeEmbeddingsMock).toHaveBeenCalledTimes(1);
		expect(computeEmbeddingsMock.mock.calls[0][1]).toEqual(['tool3', 'tool4']);
	});

	it('shoulds cache computed embeddings for future use', async () => {
		const availableTools = new Set(['tool1', 'tool2', 'tool3']);
		const queryEmbedding = createMockEmbedding([1, 0, 0]);

		rankEmbeddingMock.mockReturnValue([
			{ value: 'tool1', distance: { value: 0.2, embeddingType: EmbeddingType.text3small_512 } },
			{ value: 'tool3', distance: { value: 0.5, embeddingType: EmbeddingType.text3small_512 } }
		]);

		const computeEmbeddingsMock = vi.fn();
		const embeddingsComputerMock = { _serviceBrand: undefined, computeEmbeddings: computeEmbeddingsMock };
		const computer = createToolEmbeddingComputer(new Map([
			['tool1', createMockEmbedding([0.9, 0.1, 0])]
		]), embeddingsComputerMock);

		computeEmbeddingsMock.mockResolvedValue({
			values: [
				createMockEmbedding([0.8, 0.2, 0]), // tool2
				createMockEmbedding([0, 0, 1]) // tool3
			]
		});

		let result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toBe('tool1');
		expect(result[1]).toBe('tool3');
		expect(computeEmbeddingsMock).toHaveBeenCalledTimes(1);
		expect(computeEmbeddingsMock.mock.calls[0][1]).toEqual(['tool2', 'tool3']);

		result = await computer.retrieveSimilarEmbeddingsForAvailableTools(
			queryEmbedding,
			availableTools,
			10,
			token
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toBe('tool1');
		expect(result[1]).toBe('tool3');
		expect(computeEmbeddingsMock).toHaveBeenCalledTimes(1);
	});
});