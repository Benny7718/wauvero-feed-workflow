import { WorkflowEntrypoint } from "cloudflare:workers";

const SOURCE_NAME = "Fressnapf Awin Feed";
const FEED_PREFIX = "feeds/fressnapf/";
const CHUNK_SIZE = 256 * 1024;

type FeedSource = {
	key: string;
	size: number;
	etag: string;
};

type FeedRow = Record<string, string>;

type ParsedChunk = {
	rows: FeedRow[];
	remainder: string;
};

function normalize(value: string | undefined): string {
	return (value ?? "").trim();
}

function moneyToCents(value: string | undefined): number {
	const raw = normalize(value).replace(/[^\d,.-]/g, "");

	if (!raw) return 0;

	const comma = raw.lastIndexOf(",");
	const dot = raw.lastIndexOf(".");

	let normalized = raw;

	if (comma >= 0 && dot >= 0) {
		normalized =
			comma > dot
				? raw.replace(/\./g, "").replace(",", ".")
				: raw.replace(/,/g, "");
	} else if (comma >= 0) {
		normalized = raw.replace(/\./g, "").replace(",", ".");
	}

	const number = Number.parseFloat(normalized);

	return Number.isFinite(number)
		? Math.max(0, Math.round(number * 100))
		: 0;
}

function isAvailable(value: string | undefined): number {
	const v = normalize(value).toLowerCase();

	return [
		"0",
		"false",
		"no",
		"nein",
		"out of stock",
		"outofstock",
		"unavailable",
	].includes(v)
		? 0
		: 1;
}

/**
 * Robuster CSV-Parser.
 *
 * Wichtig:
 * - unterstützt quoted fields
 * - unterstützt Kommas innerhalb von Quotes
 * - unterstützt doppelte Quotes ("")
 * - unterstützt CRLF und LF
 * - verarbeitet keine unvollständigen Datensätze
 */
function parseCsvRecords(
	text: string,
	finalChunk: boolean,
): {
	records: string[];
	remainder: string;
} {
	const records: string[] = [];

	let field = "";
	let record: string[] = [];
	let quoted = false;
	let quoteJustClosed = false;

	const pushField = () => {
		record.push(field);
		field = "";
	};

	const pushRecord = () => {
		if (record.length > 0 || field.length > 0) {
			pushField();
			records.push(record.join("\u0001"));
			record = [];
		}
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
					quoteJustClosed = true;
				}
			} else {
				field += c;
			}

			continue;
		}

		if (quoteJustClosed) {
			if (c === ",") {
				pushField();
				quoteJustClosed = false;
				continue;
			}

			if (c === "\r" || c === "\n") {
				pushRecord();
				quoteJustClosed = false;

				if (c === "\r" && text[i + 1] === "\n") {
					i++;
				}

				continue;
			}

			/*
			 * Whitespace nach einem geschlossenen Quote
			 * tolerieren.
			 */
			if (/\s/.test(c)) {
				continue;
			}

			quoteJustClosed = false;
			field += c;
			continue;
		}

		if (c === '"') {
			quoted = true;
			continue;
		}

		if (c === ",") {
			pushField();
			continue;
		}

		if (c === "\r" || c === "\n") {
			pushRecord();

			if (c === "\r" && text[i + 1] === "\n") {
				i++;
			}

			continue;
		}

		field += c;
	}

	/*
	 * Wenn der Chunk mitten in einem quoted field endet,
	 * muss der komplette aktuelle Datensatz erhalten bleiben.
	 */
	if (quoted || quoteJustClosed || record.length > 0 || field.length > 0) {
		const partial = [
			...record,
			field,
		].join(",");

		if (finalChunk) {
			if (quoted) {
				throw new Error(
					"CSV endet mit einem nicht geschlossenen Textfeld.",
				);
			}

			if (partial.trim()) {
				records.push(partial);
			}

			return {
				records,
				remainder: "",
			};
		}

		return {
			records,
			remainder: partial,
		};
	}

	return {
		records,
		remainder: "",
	};
}

function valuesFromRecord(record: string): string[] {
	/*
	 * parseCsvRecords verwendet \u0001 nur intern
	 * als Feldtrenner. Das Zeichen wird hier wieder
	 * in echte Feldwerte zerlegt.
	 */
	return record.split("\u0001");
}

function rowFromRecord(
	record: string,
	headers: string[],
): FeedRow {
	const values = valuesFromRecord(record);
	const row: FeedRow = {};

	for (let i = 0; i < headers.length; i++) {
		row[headers[i]] = values[i] ?? "";
	}

	return row;
}

function getMpid(row: FeedRow): string {
	return (
		normalize(row.merchant_product_id) ||
		normalize(row.aw_product_id) ||
		normalize(row.product_id)
	);
}

function getEan(row: FeedRow): string | null {
	const value =
		normalize(row.product_GTIN) ||
		normalize(row.gtin) ||
		normalize(row.ean);

	return value || null;
}

function getName(row: FeedRow): string {
	return (
		normalize(row.product_name) ||
		normalize(row.product_short_description) ||
		normalize(row.name) ||
		""
	);
}

function getDescription(row: FeedRow): string {
	return (
		normalize(row.product_short_description) ||
		normalize(row.description)
	);
}

function getBrand(row: FeedRow): string | null {
	const value =
		normalize(row.brand_name) ||
		normalize(row.brand);

	return value || null;
}

function getCategory(row: FeedRow): string | null {
	const value =
		normalize(row.merchant_category) ||
		normalize(row.category_name);

	return value || null;
}

function getProductUrl(row: FeedRow): string | null {
	const value =
		normalize(row.merchant_deep_link) ||
		normalize(row.aw_deep_link) ||
		normalize(row.product_url);

	return value || null;
}

function getAffiliateUrl(row: FeedRow): string | null {
	const value =
		normalize(row.aw_deep_link) ||
		normalize(row.merchant_deep_link);

	return value || null;
}

function getImageUrl(row: FeedRow): string | null {
	const value =
		normalize(row.merchant_image_url) ||
		normalize(row.aw_image_url) ||
		normalize(row.image_url);

	return value || null;
}

function getCurrency(row: FeedRow): string {
	return normalize(row.currency) || "EUR";
}

function getUpdated(row: FeedRow): string | null {
	const value =
		normalize(row.last_updated) ||
		normalize(row.updated_at);

	return value || null;
}

function canonicalKey(row: FeedRow): string {
	const ean = getEan(row);
	const mpid = getMpid(row);

	return ean
		? `ean:${ean}`
		: `merchant-product:${mpid}`;
}

function isDogProduct(row: FeedRow): boolean {
	const category = [
		row.merchant_category,
		row.merchant_product_category_path,
		row.category_name,
	].join(" ");

	const text = [
		row.product_name,
		row.product_short_description,
		row.description,
		row.product_type,
		row.keywords,
		category,
	].join(" ");

	if (
		/\b(katze|katzen|cat|feline|katzenfutter|katzenbedarf)\b/i.test(
			text,
		)
	) {
		if (
			!/\b(hund|hunde|dog|canine|hundefutter|hundesnack|kauartikel)\b/i.test(
				text,
			)
		) {
			return false;
		}
	}

	return /\b(
		hund|
		hunde|
		dog|
		canine|
		hundefutter|
		hundesnack|
		hundesnacks|
		kauartikel|
		kausnack|
		kausnacks|
		leckerli|
		trockenfutter|
		nassfutter|
		barf
	)\b/ix.test(text);
}

function prepareRows(
	rows: FeedRow[],
): DbRow[] {
	const map = new Map<string, DbRow>();

	for (const row of rows) {
		const mpid = getMpid(row);

		if (!mpid) continue;

		const name = getName(row);

		/*
		 * Ein Datensatz, bei dem der Produktname offensichtlich
		 * eine Beschreibung ist, wird nicht importiert.
		 */
		if (
			!name ||
			name.length > 500
		) {
			continue;
		}

		const price = moneyToCents(
			row.search_price ||
				row.display_price ||
				row.price,
		);

		if (price <= 0) continue;

		const shipping = moneyToCents(
			row.delivery_cost ||
				row.shipping_cost ||
				row.shipping,
		);

		map.set(mpid, {
			key: canonicalKey(row),
			ean: getEan(row),
			brand: getBrand(row),
			name,
			category: getCategory(row),
			mpid,
			url: getProductUrl(row),
			affiliate: getAffiliateUrl(row),
			image: getImageUrl(row),
			currency: getCurrency(row),
			price,
			shipping,
			total: price + shipping,
			available: isAvailable(row.in_stock),
			updated: getUpdated(row),
		});
	}

	return Array.from(map.values());
}

async function findFeed(
	env: Env,
): Promise<FeedSource> {
	const objects: R2Object[] = [];

	let cursor: string | undefined;

	do {
		const page = await env.FEED_BUCKET.list({
			prefix: FEED_PREFIX,
			limit: 1000,
			...(cursor ? { cursor } : {}),
		});

		objects.push(
			...page.objects.filter((object) =>
				object.key.toLowerCase().endsWith(".csv"),
			),
		);

		cursor = page.truncated
			? page.cursor
			: undefined;
	} while (cursor);

	objects.sort(
		(a, b) =>
			b.uploaded.getTime() -
			a.uploaded.getTime(),
	);

	const feed = objects[0];

	if (!feed) {
		throw new Error(
			"Kein Fressnapf-CSV-Feed gefunden.",
		);
	}

	return {
		key: feed.key,
		size: feed.size,
		etag: feed.etag,
	};
}

async function readHeader(
	env: Env,
	source: FeedSource,
): Promise<{
	headers: string[];
	offset: number;
}> {
	const object = await env.FEED_BUCKET.get(
		source.key,
		{
			range: {
				offset: 0,
				length: CHUNK_SIZE,
			},
		},
	);

	if (!object) {
		throw new Error(
			"CSV-Header konnte nicht gelesen werden.",
		);
	}

	const bytes = new Uint8Array(
		await object.arrayBuffer(),
	);

	let quoted = false;
	let newline = -1;

	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 34) {
			if (quoted && bytes[i + 1] === 34) {
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (
			bytes[i] === 10 &&
			!quoted
		) {
			newline = i;
			break;
		}
	}

	if (newline < 0) {
		throw new Error(
			"CSV-Header nicht gefunden.",
		);
	}

	let headerBytes = bytes.slice(0, newline);

	if (
		headerBytes.length &&
		headerBytes[headerBytes.length - 1] === 13
	) {
		headerBytes = headerBytes.slice(0, -1);
	}

	const header = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	}).decode(headerBytes);

	const parsed = parseCsvRecords(
		header,
		true,
	);

	if (parsed.records.length !== 1) {
		throw new Error(
			"CSV-Header konnte nicht eindeutig gelesen werden.",
		);
	}

	const headers = valuesFromRecord(
		parsed.records[0],
	).map((value) =>
		value.trim(),
	);

	if (headers.length < 2) {
		throw new Error(
			"CSV-Header ist ungültig.",
		);
	}

	return {
		headers,
		offset: newline + 1,
	};
}

async function processChunk(
	env: Env,
	source: FeedSource,
	merchantId: number,
	headers: string[],
	offset: number,
	remainder: string,
): Promise<{
	nextOffset: number;
	remainder: string;
	found: number;
	imported: number;
}> {
	const length = Math.min(
		CHUNK_SIZE,
		source.size - offset,
	);

	const object = await env.FEED_BUCKET.get(
		source.key,
		{
			range: {
				offset,
				length,
			},
		},
	);

	if (!object) {
		throw new Error(
			`Feed konnte bei Offset ${offset} nicht gelesen werden.`,
		);
	}

	const bytes = new Uint8Array(
		await object.arrayBuffer(),
	);

	if (!bytes.length) {
		throw new Error(
			`Leerer Feed-Chunk bei Offset ${offset}.`,
		);
	}

	let text = "";
	let decodedLength = bytes.length;

	for (let trim = 0; trim <= 3; trim++) {
		try {
			const lengthToDecode =
				bytes.length - trim;

			text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: false,
			}).decode(
				bytes.slice(
					0,
					lengthToDecode,
				),
			);

			decodedLength = lengthToDecode;
			break;
		} catch {
			if (trim === 3) {
				throw new Error(
					`UTF-8-Dekodierung bei Offset ${offset} fehlgeschlagen.`,
				);
			}
		}
	}

	const finalChunk =
		offset + bytes.length >= source.size;

	const parsed = parseCsvRecords(
		remainder + text,
		finalChunk,
	);

	const rows: FeedRow[] = [];

	for (const record of parsed.records) {
		if (!record.trim()) continue;

		const row = rowFromRecord(
			record,
			headers,
		);

		if (isDogProduct(row)) {
			rows.push(row);
		}
	}

	const dbRows = prepareRows(rows);

	/*
	 * D1-Lastbegrenzung:
	 * Ein Chunk wird in kleinen Batches verarbeitet.
	 * Keine SELECT-Abfrage pro Produkt.
	 */
	for (
		let start = 0;
		start < dbRows.length;
		start += 100
	) {
		const batchRows = dbRows.slice(
			start,
			start + 100,
		);

		const json = JSON.stringify(batchRows);

		await env.DB.batch([
			env.DB.prepare(`
				INSERT INTO products (
					canonical_key,
					ean_gtin,
					brand,
					name,
					animal_type,
					category
				)
				SELECT
					json_extract(value, '$.key'),
					NULLIF(
						json_extract(value, '$.ean'),
						''
					),
					NULLIF(
						json_extract(value, '$.brand'),
						''
					),
					json_extract(value, '$.name'),
					'dog',
					NULLIF(
						json_extract(value, '$.category'),
						''
					)
				FROM json_each(?)
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
						CURRENT_TIMESTAMP
			`).bind(json),

			env.DB.prepare(`
				INSERT INTO merchant_products (
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
				SELECT
					?,
					p.id,
					json_extract(j.value, '$.mpid'),
					NULLIF(
						json_extract(j.value, '$.ean'),
						''
					),
					json_extract(j.value, '$.name'),
					NULLIF(
						json_extract(j.value, '$.url'),
						''
					),
					NULLIF(
						json_extract(j.value, '$.affiliate'),
						''
					),
					NULLIF(
						json_extract(j.value, '$.image'),
						''
					),
					COALESCE(
						NULLIF(
							json_extract(
								j.value,
								'$.currency'
							),
							''
						),
						'EUR'
					)
				FROM json_each(?) j
				JOIN products p
					ON p.canonical_key =
						json_extract(
							j.value,
							'$.key'
						)
				ON CONFLICT (
					merchant_id,
					merchant_product_id
				)
				DO UPDATE SET
					product_id =
						excluded.product_id,
					ean_gtin =
						excluded.ean_gtin,
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
						CURRENT_TIMESTAMP
			`).bind(
				merchantId,
				json,
			),

			env.DB.prepare(`
				INSERT INTO offers (
					merchant_product_id,
					price_cents,
					shipping_cents,
					total_price_cents,
					available,
					source_updated_at
				)
				SELECT
					mp.id,
					CAST(
						json_extract(
							j.value,
							'$.price'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.shipping'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.total'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.available'
						) AS INTEGER
					),
					NULLIF(
						json_extract(
							j.value,
							'$.updated'
						),
						''
					)
				FROM json_each(?) j
				JOIN merchant_products mp
					ON
						mp.merchant_id = ?
						AND mp.merchant_product_id =
							json_extract(
								j.value,
								'$.mpid'
							)
				ON CONFLICT (
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
						CURRENT_TIMESTAMP
			`).bind(
				json,
				merchantId,
			),

			env.DB.prepare(`
				INSERT INTO price_history (
					merchant_product_id,
					price_cents,
					shipping_cents,
					total_price_cents,
					available
				)
				SELECT
					mp.id,
					CAST(
						json_extract(
							j.value,
							'$.price'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.shipping'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.total'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.available'
						) AS INTEGER
					)
				FROM json_each(?) j
				JOIN merchant_products mp
					ON
						mp.merchant_id = ?
						AND mp.merchant_product_id =
							json_extract(
								j.value,
								'$.mpid'
							)
			`).bind(
				json,
				merchantId,
			),
		]);
	}

	return {
		nextOffset:
			Math.min(
				source.size,
				offset + decodedLength,
			),
		remainder:
			parsed.remainder,
		found:
			rows.length,
		imported:
			dbRows.length,
	};
}

export class MyWorkflow extends WorkflowEntrypoint<Env> {
	async run(
		event: any,
		step: any,
	) {
		const source = await step.do(
			"find Fressnapf feed",
			() => findFeed(this.env),
		);

		const merchant = await step.do(
			"find Fressnapf merchant",
			async () => {
				const result =
					await this.env.DB
						.prepare(`
							SELECT id, name
							FROM merchants
							WHERE name LIKE ?
							LIMIT 1
						`)
						.bind("%Fressnapf%")
						.first<{
							id: number;
							name: string;
						}>();

				if (!result) {
					throw new Error(
						"Fressnapf wurde nicht gefunden.",
					);
				}

				return result;
			},
		);

		const importId = await step.do(
			"create import",
			async () => {
				const result =
					await this.env.DB
						.prepare(`
							INSERT INTO imports (
								merchant_id,
								source_name,
								status
							)
							VALUES (?, ?, 'running')
							RETURNING id
						`)
						.bind(
							merchant.id,
							SOURCE_NAME,
						)
						.first<{
							id: number;
						}>();

				if (!result?.id) {
					throw new Error(
						"Import konnte nicht erstellt werden.",
					);
				}

				return result.id;
			},
		);

		try {
			const header = await step.do(
				"read CSV header",
				() =>
					readHeader(
						this.env,
						source,
					),
			);

			let offset = header.offset;
			let remainder = "";
			let chunkNumber = 0;
			let totalFound = 0;
			let totalImported = 0;

			while (
				offset < source.size ||
				remainder.length > 0
			) {
				const result = await step.do(
					`process Fressnapf chunk ${chunkNumber + 1}`,
					() =>
						processChunk(
							this.env,
							source,
							merchant.id,
							header.headers,
							offset,
							remainder,
						),
				);

				if (
					result.nextOffset <= offset &&
					result.remainder === remainder
				) {
					throw new Error(
						`Feed-Import macht keinen Fortschritt bei Offset ${offset}.`,
					);
				}

				offset = result.nextOffset;
				remainder = result.remainder;

				totalFound += result.found;
				totalImported += result.imported;

				chunkNumber++;

				await step.do(
					`update import ${chunkNumber}`,
					async () => {
						await this.env.DB
							.prepare(`
								UPDATE imports
								SET
									products_found = ?,
									products_imported = ?,
									products_matched = ?
								WHERE id = ?
									AND status = 'running'
							`)
							.bind(
								totalFound,
								totalImported,
								totalImported,
								importId,
							)
							.run();
					},
				);
			}

			await step.do(
				"complete import",
				async () => {
					await this.env.DB
						.prepare(`
							UPDATE imports
							SET
								status = 'completed',
								products_found = ?,
								products_imported = ?,
								products_matched = ?,
								finished_at =
									CURRENT_TIMESTAMP,
								error_message = NULL
							WHERE id = ?
						`)
						.bind(
							totalFound,
							totalImported,
							totalImported,
							importId,
						)
						.run();
				},
			);

			return {
				success: true,
				importId,
				feed: source.key,
				chunks: chunkNumber,
				productsFound: totalFound,
				productsImported: totalImported,
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);

			await this.env.DB
				.prepare(`
					UPDATE imports
					SET
						status = 'failed',
						finished_at =
							CURRENT_TIMESTAMP,
						error_message = ?
					WHERE id = ?
				`)
				.bind(
					message,
					importId,
				)
				.run();

			throw error;
		}
	}
}
