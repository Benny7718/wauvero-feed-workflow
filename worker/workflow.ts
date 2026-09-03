import { WorkflowEntrypoint } from "cloudflare:workers";
import type {
	WorkflowEvent,
	WorkflowStep,
} from "cloudflare:workers";

interface Env {
	DB: D1Database;
	FEED_BUCKET: R2Bucket;
}

type MerchantConfig = {
	key: string;
	merchantPattern: string;
	sourceName: string;
	feedPrefix: string;
	label: string;
};

const MERCHANTS: Record<string, MerchantConfig> = {
	fressnapf: {
		key: "fressnapf",
		merchantPattern: "%Fressnapf%",
		sourceName: "Fressnapf Awin Feed",
		feedPrefix: "feeds/fressnapf/",
		label: "Fressnapf",
	},
	haustierkost: {
		key: "haustierkost",
		merchantPattern: "%Haustierkost%",
		sourceName: "Haustierkost Awin Feed",
		feedPrefix: "feeds/haustierkost/",
		label: "Haustierkost",
	},
	mera: {
		key: "mera",
		merchantPattern: "%MERA%",
		sourceName: "MERA Awin Feed",
		feedPrefix: "feeds/mera/",
		label: "MERA",
	},
};

const CHUNK_SIZE = 256 * 1024;
const DB_BATCH_SIZE = 50;
const PROGRESS_EVERY_CHUNKS = 8;
const MAX_REMAINDER_BYTES = 800 * 1024;

type FeedRow = Record<string, string>;

type FeedSource = {
	key: string;
	size: number;
	etag: string;
};

type Header = {
	headers: string[];
	offset: number;
};

type ChunkResult = {
	nextOffset: number;
	found: number;
	imported: number;
	matched: number;
	done: boolean;
};

function normalize(value: string | undefined): string {
	return (value ?? "").trim();
}

function numberValue(value: string | undefined): number {
	const raw = normalize(value);

	if (!raw) {
		return 0;
	}

	const cleaned = raw
		.replace(/[^\d,.-]/g, "")
		.replace(/\.(?=\d{3}(?:\D|$))/g, "")
		.replace(",", ".");

	const result = Number.parseFloat(cleaned);

	return Number.isFinite(result) ? result : 0;
}

function cents(value: string | undefined): number {
	return Math.max(
		0,
		Math.round(numberValue(value) * 100),
	);
}

function available(value: string | undefined): number {
	const normalized = normalize(value).toLowerCase();

	if (
		[
			"0",
			"false",
			"no",
			"nein",
			"out of stock",
			"outofstock",
			"unavailable",
		].includes(normalized)
	) {
		return 0;
	}

	return 1;
}

function parseCsvLine(line: string): string[] {
	const result: string[] = [];

	let current = "";
	let quoted = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];

		if (char === '"') {
			if (
				quoted &&
				line[i + 1] === '"'
			) {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}

			continue;
		}

		if (
			char === "," &&
			!quoted
		) {
			result.push(current);
			current = "";
			continue;
		}

		current += char;
	}

	result.push(current);

	return result;
}

function splitCompleteLines(
	text: string,
): {
	lines: string[];
	remainder: string;
} {
	const lines: string[] = [];

	let start = 0;
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (char === '"') {
			if (
				quoted &&
				text[i + 1] === '"'
			) {
				i++;
			} else {
				quoted = !quoted;
			}

			continue;
		}

		if (
			(char === "\n" || char === "\r") &&
			!quoted
		) {
			lines.push(
				text.slice(start, i),
			);

			if (
				char === "\r" &&
				text[i + 1] === "\n"
			) {
				i++;
			}

			start = i + 1;
		}
	}

	return {
		lines,
		remainder: text.slice(start),
	};
}

function rowsFromLines(
	lines: string[],
	headers: string[],
): FeedRow[] {
	const rows: FeedRow[] = [];

	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}

		const values = parseCsvLine(line);
		const row: FeedRow = {};

		for (
			let i = 0;
			i < headers.length;
			i++
		) {
			row[headers[i]] =
				values[i] ?? "";
		}

		rows.push(row);
	}

	return rows;
}

function getMerchantProductId(
	row: FeedRow,
): string {
	return (
		normalize(
			row.merchant_product_id,
		) ||
		normalize(row.aw_product_id)
	);
}

function getEan(
	row: FeedRow,
): string | null {
	const value =
		normalize(row.product_GTIN) ||
		normalize(row.ean);

	return value || null;
}

function getName(
	row: FeedRow,
): string {
	return (
		normalize(
			row.product_short_description,
		) ||
		normalize(row.product_name) ||
		normalize(row.description) ||
		"Unbekanntes Produkt"
	);
}

function getBrand(
	row: FeedRow,
): string | null {
	const value =
		normalize(row.brand_name);

	return value || null;
}

function getCategory(
	row: FeedRow,
): string | null {
	const value =
		normalize(row.merchant_category);

	return value || null;
}

function getProductUrl(
	row: FeedRow,
): string | null {
	const value =
		normalize(
			row.merchant_deep_link,
		) ||
		normalize(row.aw_deep_link);

	return value || null;
}

function getAffiliateUrl(
	row: FeedRow,
): string | null {
	const value =
		normalize(row.aw_deep_link);

	return value || null;
}

function getImageUrl(
	row: FeedRow,
): string | null {
	const value =
		normalize(
			row.merchant_image_url,
		) ||
		normalize(row.aw_image_url);

	return value || null;
}

function getCurrency(
	row: FeedRow,
): string {
	return (
		normalize(row.currency) ||
		"EUR"
	);
}

function getSourceUpdatedAt(
	row: FeedRow,
): string | null {
	const value =
		normalize(row.last_updated);

	return value || null;
}

function canonicalKey(
	row: FeedRow,
): string {
	const ean = getEan(row);

	if (ean) {
		return `ean:${ean}`;
	}

	return `merchant-product:${getMerchantProductId(
		row,
	)}`;
}

function isDogProduct(
	row: FeedRow,
): boolean {
	const category = [
		row.merchant_category,
		row.merchant_product_category_path,
		row.category_name,
	]
		.join(" ")
		.toLowerCase();

	const text = [
		row.product_short_description,
		row.product_name,
		row.description,
		row.product_type,
		row.keywords,
	]
		.join(" ")
		.toLowerCase();

	const catDog =
		/(^|>|\s)(hund|hunde|dog|canine)(\s|>|$)/i.test(
			category,
		);

	const catCat =
		/(^|>|\s)(katze|katzen|cat|feline)(\s|>|$)/i.test(
			category,
		);

	if (catDog && !catCat) {
		return true;
	}

	if (catCat && !catDog) {
		return false;
	}

	return (
		/\b(hund|hunde|dog|canine|puppy|welpe|hundefutter|hundesnack|hundesnacks|kausnack|kauartikel|trockenfutter|nassfutter|barf)\b/i.test(
			text,
		) &&
		!/\b(katzenfutter|katzenstreu|katzenbedarf|cat food)\b/i.test(
			text,
		)
	);
}

async function findFeed(
	env: Env,
	config: MerchantConfig,
): Promise<FeedSource> {
	const feeds: R2Object[] = [];

	let cursor: string | undefined;

	do {
		const page =
			await env.FEED_BUCKET.list({
				prefix: config.feedPrefix,
				limit: 1000,
				...(cursor
					? { cursor }
					: {}),
			});

		for (const object of page.objects) {
			if (
				object.key
					.toLowerCase()
					.endsWith(".csv")
			) {
				feeds.push(object);
			}
		}

		cursor = page.truncated
			? page.cursor
			: undefined;
	} while (cursor);

	feeds.sort(
		(a: R2Object, b: R2Object) =>
			b.uploaded.getTime() -
			a.uploaded.getTime(),
	);

	if (feeds.length === 0) {
		throw new Error(
			`Kein ${config.label}-CSV-Feed in R2 gefunden.`,
		);
	}

	const feed = feeds[0];

	return {
		key: feed.key,
		size: feed.size,
		etag: feed.etag,
	};
}

async function readHeader(
	env: Env,
	key: string,
): Promise<Header> {
	const object =
		await env.FEED_BUCKET.get(
			key,
			{
				range: {
					offset: 0,
					length: CHUNK_SIZE,
				},
			},
		);

	if (
		!object ||
		!("body" in object) ||
		!object.body
	) {
		throw new Error(
			"CSV-Header konnte nicht gelesen werden.",
		);
	}

	const bytes =
		new Uint8Array(
			await object.arrayBuffer(),
		);

	const newlineByte =
		bytes.indexOf(0x0a);

	if (newlineByte < 0) {
		throw new Error(
			"CSV enthält keine Kopfzeile.",
		);
	}

	let headerLine =
		new TextDecoder(
			"utf-8",
			{
				fatal: true,
				ignoreBOM: false,
			},
		).decode(
			bytes.slice(
				0,
				newlineByte,
			),
		);

	headerLine =
		headerLine.replace(
			/\r$/,
			"",
		);

	if (
		headerLine.charCodeAt(0) ===
		0xfeff
	) {
		headerLine =
			headerLine.slice(1);
	}

	const headers =
		parseCsvLine(
			headerLine,
		).map(
			(value) =>
				value.trim(),
		);

	if (headers.length < 2) {
		throw new Error(
			"CSV-Header ist ungültig.",
		);
	}

	return {
		headers,
		offset:
			newlineByte + 1,
	};
}

function stateKey(
	instanceId: string,
): string {
	return `workflow-state/fressnapf/${instanceId}.txt`;
}

async function readRemainder(
	env: Env,
	instanceId: string,
): Promise<string> {
	const object =
		await env.FEED_BUCKET.get(
			stateKey(instanceId),
		);

	if (!object) {
		return "";
	}

	return object.text();
}

async function writeRemainder(
	env: Env,
	instanceId: string,
	remainder: string,
): Promise<void> {
	const bytes =
		new TextEncoder().encode(
			remainder,
		);

	if (
		bytes.byteLength >
		MAX_REMAINDER_BYTES
	) {
		throw new Error(
			"CSV enthält eine einzelne Zeile, die größer als der zulässige Chunk-Puffer ist.",
		);
	}

	if (remainder.length === 0) {
		await env.FEED_BUCKET.delete(
			stateKey(instanceId),
		);
		return;
	}

	await env.FEED_BUCKET.put(
		stateKey(instanceId),
		bytes,
		{
			httpMetadata: {
				contentType:
					"text/plain; charset=utf-8",
			},
		},
	);
}

async function processChunk(
	env: Env,
	source: FeedSource,
	merchantId: number,
	headers: string[],
	instanceId: string,
	currentOffset: number,
): Promise<ChunkResult> {
	const object =
		await env.FEED_BUCKET.get(
			source.key,
			{
				range: {
					offset:
						currentOffset,
					length:
						CHUNK_SIZE,
				},
				onlyIf: {
					etagMatches:
						source.etag,
				},
			},
		);

	if (
		!object ||
		!("body" in object) ||
		!object.body
	) {
		throw new Error(
			`R2-Feed konnte bei Offset ${currentOffset} nicht gelesen werden oder wurde während des Imports geändert.`,
		);
	}

	const bytes =
		new Uint8Array(
			await object.arrayBuffer(),
		);

	if (bytes.byteLength === 0) {
		throw new Error(
			`R2-Feed lieferte bei Offset ${currentOffset} keine Daten.`,
		);
	}

	const remainder =
		await readRemainder(
			env,
			instanceId,
		);

	const decoder =
		new TextDecoder(
			"utf-8",
			{
				fatal: true,
				ignoreBOM: false,
			},
		);

	let decoded: string;

	try {
		decoded =
			decoder.decode(bytes);
	} catch {
		throw new Error(
			`UTF-8-Dekodierung bei Offset ${currentOffset} fehlgeschlagen.`,
		);
	}

	const combined =
		remainder + decoded;

	const split =
		splitCompleteLines(
			combined,
		);

	const rows =
		rowsFromLines(
			split.lines,
			headers,
		);

	const dogRows =
		rows.filter(
			isDogProduct,
		);

	const statements:
		D1PreparedStatement[] = [];

	let importedChunk = 0;

	for (const row of dogRows) {
		const merchantProductId =
			getMerchantProductId(
				row,
			);

		if (!merchantProductId) {
			continue;
		}

		const priceCents =
			cents(
				row.search_price ||
					row.display_price,
			);

		if (priceCents <= 0) {
			continue;
		}

		const shippingCents =
			cents(
				row.delivery_cost,
			);

		const totalPriceCents =
			priceCents +
			shippingCents;

		const isAvailable =
			available(
				row.in_stock,
			);

		const ean =
			getEan(row);

		const key =
			canonicalKey(row);

		const productName =
			getName(row);

		const brand =
			getBrand(row);

		const category =
			getCategory(row);

		const productUrl =
			getProductUrl(row);

		const affiliateUrl =
			getAffiliateUrl(row);

		const imageUrl =
			getImageUrl(row);

		const currency =
			getCurrency(row);

		const sourceUpdatedAt =
			getSourceUpdatedAt(row);

		statements.push(
			env.DB.prepare(
				`INSERT INTO products (
					canonical_key,
					ean_gtin,
					brand,
					name,
					animal_type,
					category
				)
				SELECT
					?,
					?,
					?,
					?,
					'dog',
					?
				WHERE NOT EXISTS (
					SELECT 1
					FROM products
					WHERE ean_gtin = ?
					AND ean_gtin IS NOT NULL
					AND ean_gtin <> ''
				)
				ON CONFLICT(canonical_key)
				DO UPDATE SET
					ean_gtin =
						COALESCE(
							excluded.ean_gtin,
							products.ean_gtin
						),
					brand =
						COALESCE(
							excluded.brand,
							products.brand
						),
					name =
						excluded.name,
					animal_type =
						'dog',
					category =
						COALESCE(
							excluded.category,
							products.category
						),
					updated_at =
						CURRENT_TIMESTAMP`,
			).bind(
				key,
				ean,
				brand,
				productName,
				category,
				ean,
			),
		);

		if (ean) {
			statements.push(
				env.DB.prepare(
					`UPDATE products
					 SET
						brand = ?,
						name = ?,
						animal_type = 'dog',
						category =
							COALESCE(
								?,
								category
							),
						updated_at =
							CURRENT_TIMESTAMP
					 WHERE ean_gtin = ?`,
				).bind(
					brand,
					productName,
					category,
					ean,
				),
			);
		}

		statements.push(
			env.DB.prepare(
				`INSERT INTO merchant_products (
					merchant_id,
					product_id,
					merchant_product_id,
					ean_gtin,
					product_name,
					product_url,
					affiliate_url,
					image_url,
					currency
				)
				VALUES (
					?,
					(
						SELECT id
						FROM products
						WHERE
							(
								ean_gtin = ?
								AND ean_gtin IS NOT NULL
								AND ean_gtin <> ''
							)
							OR canonical_key = ?
						ORDER BY
							CASE
								WHEN ean_gtin = ?
								THEN 0
								ELSE 1
							END
						LIMIT 1
					),
					?,
					?,
					?,
					?,
					?,
					?,
					?
				)
				ON CONFLICT(
					merchant_id,
					merchant_product_id
				)
				DO UPDATE SET
					product_id =
						excluded.product_id,
					ean_gtin =
						COALESCE(
							excluded.ean_gtin,
							merchant_products.ean_gtin
						),
					product_name =
						excluded.product_name,
					product_url =
						excluded.product_url,
					affiliate_url =
						excluded.affiliate_url,
					image_url =
						excluded.image_url,
					currency =
						excluded.currency,
					updated_at =
						CURRENT_TIMESTAMP`,
			).bind(
				merchantId,
				ean,
				key,
				ean,
				merchantProductId,
				ean,
				productName,
				productUrl,
				affiliateUrl,
				imageUrl,
				currency,
			),
		);

		statements.push(
			env.DB.prepare(
				`INSERT INTO offers (
					merchant_product_id,
					price_cents,
					shipping_cents,
					total_price_cents,
					available,
					source_updated_at
				)
				VALUES (
					(
						SELECT id
						FROM merchant_products
						WHERE
							merchant_id = ?
							AND merchant_product_id = ?
						LIMIT 1
					),
					?,
					?,
					?,
					?,
					?
				)
				ON CONFLICT(
					merchant_product_id
				)
				DO UPDATE SET
					price_cents =
						excluded.price_cents,
					shipping_cents =
						excluded.shipping_cents,
					total_price_cents =
						excluded.total_price_cents,
					available =
						excluded.available,
					source_updated_at =
						excluded.source_updated_at,
					checked_at =
						CURRENT_TIMESTAMP`,
			).bind(
				merchantId,
				merchantProductId,
				priceCents,
				shippingCents,
				totalPriceCents,
				isAvailable,
				sourceUpdatedAt,
			),
		);

		importedChunk++;
	}

	for (
		let i = 0;
		i < statements.length;
		i += DB_BATCH_SIZE
	) {
		const batch =
			statements.slice(
				i,
				i + DB_BATCH_SIZE,
			);

		if (batch.length > 0) {
			await env.DB.batch(
				batch,
			);
		}
	}

	await writeRemainder(
		env,
		instanceId,
		split.remainder,
	);

	const nextOffset =
		Math.min(
			source.size,
			currentOffset +
				bytes.byteLength,
		);

	const done =
		nextOffset >= source.size &&
		split.remainder.length === 0;

	if (
		done &&
		remainder.length > 0 &&
		split.lines.length === 0
	) {
		throw new Error(
			"CSV endet mit einem unvollständigen Datensatz.",
		);
	}

	return {
		nextOffset,
		found: dogRows.length,
		imported: importedChunk,
		matched: importedChunk,
		done,
	};
}

export class MyWorkflow
	extends WorkflowEntrypoint<Env> {
	async run(
		event: WorkflowEvent<
			Record<string, unknown>
		>,
		step: WorkflowStep,
	) {
		const instanceId =
			event.instanceId;

		const payload =
			event.payload as Record<string, unknown>;

		const requestedMerchant =
			typeof payload?.merchant === "string"
				? payload.merchant.toLowerCase().trim()
				: "fressnapf";

		const config =
			MERCHANTS[requestedMerchant];

		if (!config) {
			throw new Error(
				`Unbekannter Merchant "${requestedMerchant}". Erlaubt sind: ${Object.keys(MERCHANTS).join(", ")}.`,
			);
		}

		const source =
			await step.do(
				`find ${config.label} feed`,
				async (): Promise<FeedSource> =>
					findFeed(this.env, config),
			);

		const merchant =
			await step.do(
				`find ${config.label} merchant`,
				async (): Promise<{
					id: number;
					name: string;
				}> => {
					const result =
						await this.env.DB
							.prepare(
								`SELECT
									id,
									name
								 FROM merchants
								 WHERE name LIKE ?
								 LIMIT 1`,
							)
							.bind(config.merchantPattern)
							.first<{
								id: number;
								name: string;
							}>();

					if (!result) {
						throw new Error(
							`${config.label}-Merchant wurde in D1 nicht gefunden.`,
						);
					}

					return result;
				},
			);

		const importId =
			await step.do(
				"create import record",
				async (): Promise<number> => {
					const result =
						await this.env.DB
							.prepare(
								`INSERT INTO imports (
									merchant_id,
									source_name,
									status,
									products_found,
									products_imported,
									products_matched
								)
								VALUES (
									?,
									?,
									'running',
									0,
									0,
									0
								)
								RETURNING id`,
							)
							.bind(
								merchant.id,
								config.sourceName,
							)
							.first<{
								id: number;
							}>();

					if (!result?.id) {
						throw new Error(
							"Import-Datensatz konnte nicht erstellt werden.",
						);
					}

					return result.id;
				},
			);

		const header =
			await step.do(
				"read CSV header",
				async (): Promise<Header> =>
					readHeader(
						this.env,
						source.key,
					),
			);

		let offset =
			header.offset;

		let productsFound = 0;
		let productsImported = 0;
		let productsMatched = 0;
		let chunkNumber = 0;

		try {
			while (
				offset < source.size
			) {
				const currentOffset: number =
					offset;

				const currentChunkNumber: number =
					chunkNumber + 1;

				const result: ChunkResult =
					await step.do(
						`process ${config.label} chunk ${currentChunkNumber}`,
						async (): Promise<ChunkResult> =>
							processChunk(
								this.env,
								source,
								merchant.id,
								header.headers,
								instanceId,
								currentOffset,
							),
					);

				if (
					result.nextOffset <=
						currentOffset &&
					!result.done
				) {
					throw new Error(
						`Feed-Import macht keinen Fortschritt bei Offset ${currentOffset}.`,
					);
				}

				offset =
					result.nextOffset;

				productsFound +=
					result.found;

				productsImported +=
					result.imported;

				productsMatched +=
					result.matched;

				chunkNumber =
					currentChunkNumber;

				if (
					result.done ||
					chunkNumber %
						PROGRESS_EVERY_CHUNKS ===
						0
				) {
					const progressFound =
						productsFound;

					const progressImported =
						productsImported;

					const progressMatched =
						productsMatched;

					await step.do(
						`save progress ${chunkNumber}`,
						async (): Promise<void> => {
							await this.env.DB
								.prepare(
									`UPDATE imports
									 SET
										products_found = ?,
										products_imported = ?,
										products_matched = ?
									 WHERE
										id = ?
										AND status = 'running'`,
								)
								.bind(
									progressFound,
									progressImported,
									progressMatched,
									importId,
								)
								.run();
						},
					);
				}

				if (result.done) {
					break;
				}
			}

			await step.do(
				"complete import",
				async (): Promise<void> => {
					await this.env.DB
						.prepare(
							`UPDATE imports
							 SET
								status = 'completed',
								products_found = ?,
								products_imported = ?,
								products_matched = ?,
								finished_at =
									CURRENT_TIMESTAMP,
								error_message = NULL
							 WHERE id = ?`,
						)
						.bind(
							productsFound,
							productsImported,
							productsMatched,
							importId,
						)
						.run();

					await this.env.FEED_BUCKET.delete(
						stateKey(instanceId),
					);
				},
			);

			return {
				success: true,
				instanceId,
				importId,
				merchant:
					merchant.name,
				feed:
					source.key,
				productsFound,
				productsImported,
				productsMatched,
				chunks:
					chunkNumber,
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);

			await step.do(
				"mark import failed",
				async (): Promise<void> => {
					await this.env.DB
						.prepare(
							`UPDATE imports
							 SET
								status = 'failed',
								finished_at =
									CURRENT_TIMESTAMP,
								error_message = ?
							 WHERE id = ?`,
						)
						.bind(
							message,
							importId,
						)
						.run();
				},
			);

			throw error;
		}
	}
}
