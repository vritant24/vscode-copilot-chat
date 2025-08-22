/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Run this script from the root directory with:
 * npx ts-node script/telemetry-logger.ts
 */

import * as http from 'http';
import * as zlib from 'zlib';

const PORT = 3000;

interface TelemetryResponse {
	status: string;
	timestamp: string;
	message: string;
}

// Create a simple HTTP server
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
	const timestamp = new Date().toISOString();
	const method = req.method;
	const requestUrl = req.url;
	const headers = req.headers;

	console.log(`\n=== Telemetry Request Received ===`);
	console.log(`Timestamp: ${timestamp}`);
	console.log(`Method: ${method}`);
	console.log(`URL: ${requestUrl}`);
	console.log(`Headers:`, JSON.stringify(headers, null, 2));

	// Collect request body if present
	let body = '';
	const isGzipped = headers['content-encoding'] === 'gzip';

	req.on('data', (chunk: Buffer) => {
		body += chunk.toString('binary'); // Use binary encoding for gzipped data
	});

	req.on('end', () => {
		if (body) {
			if (isGzipped) {
				try {
					// Convert binary string back to buffer and decompress
					const buffer = Buffer.from(body, 'binary');
					const decompressed = zlib.gunzipSync(buffer);
					const decompressedText = decompressed.toString('utf8');

					console.log(`Body (gzipped, decompressed):`, decompressedText);
					try {
						const parsedBody = JSON.parse(decompressedText);
						console.log(`Parsed Body (from gzip):`, JSON.stringify(parsedBody, null, 2));
					} catch (e) {
						console.log(`Body (decompressed, raw):`, decompressedText);
					}
				} catch (e: any) {
					console.log(`Error decompressing gzipped body:`, e.message);
					console.log(`Body (raw gzipped):`, body);
				}
			} else {
				console.log(`Body:`, body);
				try {
					const parsedBody = JSON.parse(body);
					console.log(`Parsed Body:`, JSON.stringify(parsedBody, null, 2));
				} catch (e) {
					console.log(`Body (raw):`, body);
				}
			}
		}
		console.log(`================================\n`);

		// Send a simple response
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization'
		});

		const response: TelemetryResponse = {
			status: 'received',
			timestamp: timestamp,
			message: 'Telemetry logged successfully'
		};

		res.end(JSON.stringify(response));
	});
});

// Handle CORS preflight requests
server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(200, {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization'
		});
		res.end();
	}
});

// Start the server
server.listen(PORT, () => {
	console.log(`Telemetry Logger Service started on port ${PORT}`);
	console.log(`Listening for requests at http://localhost:${PORT}`);
	console.log(`Press Ctrl+C to stop the service\n`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down telemetry logger service...');
	server.close(() => {
		console.log('Service stopped.');
		process.exit(0);
	});
});

// Handle errors
server.on('error', (err: Error) => {
	console.error('Server error:', err);
});