import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Default note property used to store the fractional index string. */
export const DEFAULT_INDEX_PROPERTY = "fractional_index";

/** Key of the Bases view option which selects the index property. */
export const INDEX_PROPERTY_OPTION = "indexProperty";

const RESERVED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

export interface Row {
	/** Stable identity of the row. File paths are unique inside a vault. */
	id: string;
	/** Raw frontmatter value of the index property. */
	index: unknown;
}

export interface IndexWrite {
	id: string;
	index: string;
	previous: unknown;
}

/**
 * Validate the user-configured property name. `note.` is accepted because
 * people often paste a Bases property id into the text option.
 */
export function indexProperty(raw: unknown): string {
	if (raw === undefined || raw === null || raw === "") return DEFAULT_INDEX_PROPERTY;
	if (typeof raw !== "string") throw new Error("Use a plain note property name.");
	let name = raw.trim();
	if (name === "") return DEFAULT_INDEX_PROPERTY;
	if (name.startsWith("note.")) name = name.slice("note.".length);
	if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name) || RESERVED_PROPERTIES.has(name)) {
		throw new Error(
			"Use a plain note property name with letters, numbers, underscores or hyphens.",
		);
	}
	return name;
}

/** Convert a stored value into an index key, or null when it is empty. */
export function indexKey(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error(
			"The index property contains a non-string value. Clear or repair that value first.",
		);
	}
	const key = value.trim();
	return key === "" ? null : key;
}

/** Compare an existing frontmatter value with a planned previous value. */
export function sameIndexValue(left: unknown, right: unknown): boolean {
	return comparableValue(left) === comparableValue(right);
}

function comparableValue(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") {
		const text = value.trim();
		return text === "" ? null : text;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? null;
	} catch {
		return null;
	}
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rows with an index come first, sorted lexicographically. Empty indexes sort
 * after them by file path. This is the on-disk order other tools can reproduce.
 */
export function sortRows<T extends Row>(rows: T[]): T[] {
	return [...rows].sort((a, b) => {
		const ka = indexKey(a.index);
		const kb = indexKey(b.index);
		if (ka !== null && kb !== null) {
			if (ka !== kb) return ka < kb ? -1 : 1;
			return compareIds(a.id, b.id);
		}
		if (ka !== null) return -1;
		if (kb !== null) return 1;
		return compareIds(a.id, b.id);
	});
}

/**
 * Plan the smallest set of index writes that puts `source` before `before`
 * (or at the end when `before` is null).
 *
 * Only the moved row usually needs a new key. When a requested position cannot
 * be represented by unindexed rows sorting after all indexed rows, the shortest
 * necessary prefix of the new order is indexed too. Indexes are never assigned
 * to the whole group up front.
 */
export function planMove(rows: Row[], source: string, before: string | null): IndexWrite[] {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) {
		throw new Error("Duplicate notes in this group.");
	}

	const original = sortRows(rows);
	if (!original.some((row) => row.id === source)) {
		throw new Error("The notes changed. Try the move again.");
	}
	if (before !== null && !original.some((row) => row.id === before)) {
		throw new Error("The notes changed. Try the move again.");
	}
	if (source === before) return [];

	// Validate every value before planning, so a malformed property never gets
	// partially overwritten.
	const current = new Map<string, string | null>();
	for (const row of original) current.set(row.id, indexKey(row.index));

	const moved = original.find((row) => row.id === source);
	if (!moved) throw new Error("The notes changed. Try the move again.");

	const next = original.filter((row) => row.id !== source);
	const target = before === null ? next.length : next.findIndex((row) => row.id === before);
	next.splice(target, 0, moved);

	if (next.every((row, position) => row.id === original[position]?.id)) return [];

	// The unindexed rows may only be a suffix of the desired order, and that
	// suffix must already be path-sorted. Find the longest such suffix: every
	// row before it has to end up with a key.
	let suffixStart = next.length;
	for (let start = 0; start <= next.length; start++) {
		let valid = true;
		for (let position = start; position < next.length; position++) {
			const row = next[position];
			if (!row) {
				valid = false;
				break;
			}
			if (current.get(row.id) !== null) {
				valid = false;
				break;
			}
			const previous = position === start ? undefined : next[position - 1];
			if (previous && compareIds(previous.id, row.id) > 0) {
				valid = false;
				break;
			}
		}
		if (valid) {
			suffixStart = start;
			break;
		}
	}

	const prefix = next.slice(0, suffixStart);
	const needsKey = prefix.map(
		(row) => row.id === source || current.get(row.id) === null,
	);
	const writes: IndexWrite[] = [];
	let left: string | null = null;
	let position = 0;

	while (position < prefix.length) {
		const row = prefix[position];
		if (!row) break;

		if (!needsKey[position]) {
			left = current.get(row.id) ?? left;
			position++;
			continue;
		}

		let runEnd = position;
		while (runEnd < prefix.length && needsKey[runEnd]) runEnd++;

		const nextRow = prefix[runEnd];
		const right = nextRow ? current.get(nextRow.id) ?? null : null;
		const count = runEnd - position;

		let keys: string[];
		try {
			keys = generateNKeysBetween(left, right, count);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not create an index between ${left ?? "the start"} and ${right ?? "the end"}. ${reason}`,
			);
		}

		for (let offset = 0; offset < count; offset++) {
			const targetRow = prefix[position + offset];
			const key = keys[offset];
			if (!targetRow || key === undefined) continue;
			if (current.get(targetRow.id) !== key) {
				writes.push({ id: targetRow.id, index: key, previous: targetRow.index });
			}
		}

		left = keys[keys.length - 1] ?? left;
		position = runEnd;
	}

	return writes;
}

/**
 * Future "Balance" action: re-key every visible row with short, evenly spaced
 * keys. This must only run from an explicit user action because it rewrites
 * more notes than a normal move.
 */
export function planBalance(rows: Row[]): IndexWrite[] {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) {
		throw new Error("Duplicate notes in this group.");
	}
	const ordered = sortRows(rows);
	const keys = generateNKeysBetween(null, null, ordered.length);
	return ordered.flatMap((row, position) => {
		const key = keys[position];
		if (key === undefined || indexKey(row.index) === key) return [];
		return [{ id: row.id, index: key, previous: row.index }];
	});
}

/** Generate one key between two bounds. Kept for callers that need a single key. */
export function keyBetween(left: string | null, right: string | null): string {
	return generateKeyBetween(left, right);
}
