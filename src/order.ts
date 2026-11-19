import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Default note property used to store the fractional index string. */
export const DEFAULT_INDEX_PROPERTY = "fractional_index";

/** Key of the Bases view option which selects the index property. */
export const INDEX_PROPERTY_OPTION = "indexProperty";

/** Key of the view option which stores the display direction. */
export const SORT_DIRECTION_OPTION = "sortDirection";

/** Ascending is the stored key order; descending only reverses the display. */
export type OrderDirection = "asc" | "desc";

/** Edge of the displayed block of indexed notes. */
export type Edge = "top" | "bottom";

/** Where unindexed notes are shown relative to the indexed block. */
export type UnindexedPlacement = "after" | "before";

/** Key of the view option which stores unindexed placement. */
export const UNINDEXED_PLACEMENT_OPTION = "unindexedPlacement";

const RESERVED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

export interface Row {
	/** Stable identity of the row. File paths are unique inside a vault. */
	id: string;
	/** Raw frontmatter value of the index property. */
	index: unknown;
	/**
	 * Display/order rank among unindexed rows. When native Bases sort is enabled
	 * this follows the Bases-provided order; otherwise it follows path order.
	 */
	unindexedRank?: number;
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

function compareUnindexed(a: Row, b: Row): number {
	const rankA = a.unindexedRank;
	const rankB = b.unindexedRank;
	if (rankA !== undefined && rankB !== undefined && rankA !== rankB) {
		return rankA < rankB ? -1 : 1;
	}
	return compareIds(a.id, b.id);
}

/**
 * Rows with an index come first, sorted lexicographically. Empty indexes sort
 * after them by unindexed rank (Bases sort when enabled, otherwise file path).
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
		return compareUnindexed(a, b);
	});
}

/** Read a persisted display direction. Unknown values mean ascending. */
export function sortDirection(value: unknown): OrderDirection {
	return value === "desc" ? "desc" : "asc";
}

/** Read a persisted unindexed placement. Unknown values mean after indexed notes. */
export function unindexedPlacement(value: unknown): UnindexedPlacement {
	return value === "before" ? "before" : "after";
}

/**
 * Sort rows for display. The indexed block follows the display direction while
 * unindexed rows stay together, placed before or after the indexed block.
 */
export function displayRows<T extends Row>(
	rows: T[],
	direction: OrderDirection,
	placement: UnindexedPlacement = "after",
): T[] {
	const sorted = sortRows(rows);
	let firstUnindexed = sorted.length;
	for (let index = 0; index < sorted.length; index++) {
		if (indexKey(sorted[index]?.index) === null) {
			firstUnindexed = index;
			break;
		}
	}

	const indexed = sorted.slice(0, firstUnindexed);
	const unindexed = sorted.slice(firstUnindexed);
	const indexedBlock = direction === "asc" ? indexed : [...indexed].reverse();

	return placement === "before"
		? [...unindexed, ...indexedBlock]
		: [...indexedBlock, ...unindexed];
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
			if (previous && compareUnindexed(previous, row) > 0) {
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

function validateMoveRequest(rows: Row[], source: string, beforeDisplay: string | null): {
	canonical: Row[];
	sourceRow: Row;
	withoutSource: Row[];
} {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) {
		throw new Error("Duplicate notes in this group.");
	}
	const canonical = sortRows(rows);
	const sourceRow = canonical.find((row) => row.id === source);
	if (!sourceRow) {
		throw new Error("The notes changed. Try the move again.");
	}
	if (beforeDisplay !== null && !canonical.some((row) => row.id === beforeDisplay)) {
		throw new Error("The notes changed. Try the move again.");
	}
	if (source === beforeDisplay) {
		return { canonical, sourceRow, withoutSource: canonical.filter((row) => row.id !== source) };
	}
	return { canonical, sourceRow, withoutSource: canonical.filter((row) => row.id !== source) };
}

function ensurePromotedAtCanonical(
	rows: Row[],
	sourceRow: Row,
	withoutSource: Row[],
	canonicalBefore: string | null,
	writes: IndexWrite[],
	shouldPromote: boolean,
): IndexWrite[] {
	if (!shouldPromote || indexKey(sourceRow.index) !== null || writes.some((write) => write.id === sourceRow.id)) {
		return writes;
	}

	const insertAt =
		canonicalBefore === null
			? withoutSource.length
			: withoutSource.findIndex((row) => row.id === canonicalBefore);
	let left: string | null = null;
	for (let index = insertAt - 1; index >= 0; index--) {
		const key = indexKey(withoutSource[index]?.index);
		if (key !== null) {
			left = key;
			break;
		}
	}
	let right: string | null = null;
	for (let index = insertAt; index < withoutSource.length; index++) {
		const key = indexKey(withoutSource[index]?.index);
		if (key !== null) {
			right = key;
			break;
		}
	}

	let key: string;
	try {
		key = generateKeyBetween(left, right);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not create an index between ${left ?? "the start"} and ${right ?? "the end"}. ${reason}`,
		);
	}
	if (indexKey(sourceRow.index) === key) return writes;
	return [...writes, { id: sourceRow.id, index: key, previous: sourceRow.index }];
}

/**
 * Plan a move expressed in display order. `beforeDisplay` is the row that the
 * source should precede in the displayed list, or null to place it at the end
 * of the display.
 */
export function planDisplayMove(
	rows: Row[],
	source: string,
	beforeDisplay: string | null,
	direction: OrderDirection,
	placement: UnindexedPlacement = "after",
): IndexWrite[] {
	const { canonical, sourceRow, withoutSource } = validateMoveRequest(rows, source, beforeDisplay);
	if (source === beforeDisplay) return [];

	if (placement === "after") {
		if (direction === "asc") return planMove(rows, source, beforeDisplay);

		let canonicalBefore: string | null;
		let indexedHeadTarget = false;

		if (beforeDisplay === null) {
			const last = canonical[canonical.length - 1];
			if (last && indexKey(last.index) === null) {
				canonicalBefore = null;
			} else {
				canonicalBefore = withoutSource.find((row) => indexKey(row.index) !== null)?.id ?? null;
				indexedHeadTarget = true;
			}
		} else {
			const target = canonical.find((row) => row.id === beforeDisplay);
			if (!target) throw new Error("The notes changed. Try the move again.");
			if (indexKey(target.index) === null) {
				canonicalBefore = beforeDisplay;
			} else {
				const index = withoutSource.findIndex((row) => row.id === beforeDisplay);
				canonicalBefore = withoutSource[index + 1]?.id ?? null;
				indexedHeadTarget = true;
			}
		}

		const writes = planMove(rows, source, canonicalBefore);
		return ensurePromotedAtCanonical(rows, sourceRow, withoutSource, canonicalBefore, writes, indexedHeadTarget);
	}

	// placement === "before": unindexed notes are shown as a head block.
	const firstIndexed = canonical.find((row) => indexKey(row.index) !== null);
	const lastIndexed = [...canonical].reverse().find((row) => indexKey(row.index) !== null);

	if (direction === "asc") {
		let canonicalBefore: string | null;
		let indexedTarget = false;

		if (beforeDisplay === null) {
			// End of display = bottom of indexed block.
			if (lastIndexed) {
				canonicalBefore =
					withoutSource.find((row) => indexKey(row.index) === null)?.id ?? null;
				indexedTarget = true;
			} else {
				canonicalBefore = null;
			}
		} else {
			const target = canonical.find((row) => row.id === beforeDisplay);
			if (!target) throw new Error("The notes changed. Try the move again.");
			if (indexKey(target.index) === null) {
				// Within unindexed head: treat as joining top of indexed block.
				canonicalBefore = firstIndexed
					? firstIndexed.id === source
						? withoutSource.find((row) => indexKey(row.index) !== null)?.id ?? null
						: firstIndexed.id
					: withoutSource.find((row) => indexKey(row.index) === null)?.id ?? null;
				indexedTarget = !!firstIndexed;
				if (!firstIndexed) {
					// all unindexed: top of empty indexed block
					canonicalBefore = withoutSource[0]?.id ?? null;
					indexedTarget = true;
				}
			} else {
				canonicalBefore = beforeDisplay;
				indexedTarget = true;
			}
		}

		const writes = planMove(rows, source, canonicalBefore);
		return ensurePromotedAtCanonical(rows, sourceRow, withoutSource, canonicalBefore, writes, indexedTarget);
	}

	// direction === "desc", placement === "before"
	let canonicalBefore: string | null;
	let indexedTarget = false;

	if (beforeDisplay === null) {
		// End of display = bottom of indexed block in desc = smallest indexed key.
		if (lastIndexed) {
			canonicalBefore = withoutSource.find((row) => indexKey(row.index) !== null)?.id ?? null;
			indexedTarget = true;
		} else {
			canonicalBefore = null;
		}
	} else {
		const target = canonical.find((row) => row.id === beforeDisplay);
		if (!target) throw new Error("The notes changed. Try the move again.");
		if (indexKey(target.index) === null) {
			// Unindexed head in display -> join top of indexed block in desc = after largest key.
			canonicalBefore = withoutSource.find((row) => indexKey(row.index) === null)?.id ?? null;
			indexedTarget = !!lastIndexed;
			if (!lastIndexed) {
				canonicalBefore = withoutSource[0]?.id ?? null;
				indexedTarget = true;
			}
		} else {
			const index = withoutSource.findIndex((row) => row.id === beforeDisplay);
			canonicalBefore = withoutSource[index + 1]?.id ?? null;
			indexedTarget = true;
		}
	}

	const writes = planMove(rows, source, canonicalBefore);
	return ensurePromotedAtCanonical(rows, sourceRow, withoutSource, canonicalBefore, writes, indexedTarget);
}

/**
 * Plan a drag-and-drop expressed in display order. Dropping next to unindexed
 * notes is treated as joining the adjacent edge of the indexed block (single
 * write), accounting for display direction and unindexed placement.
 */
export function planDrop(
	rows: Row[],
	source: string,
	beforeDisplay: string | null,
	direction: OrderDirection,
	placement: UnindexedPlacement = "after",
): IndexWrite[] {
	const display = displayRows(rows, direction, placement);
	let insertAt: number;
	if (beforeDisplay === null) {
		insertAt = display.length;
	} else {
		insertAt = display.findIndex((row) => row.id === beforeDisplay);
		if (insertAt < 0) throw new Error("The notes changed. Try the move again.");
	}

	if (placement === "after") {
		let tailStart = display.length;
		for (let index = 0; index < display.length; index++) {
			if (indexKey(display[index]?.index) === null) {
				tailStart = index;
				break;
			}
		}
		if (insertAt >= tailStart) {
			return planEdgeMove(rows, source, "bottom", direction, placement);
		}
	} else {
		let headEnd = 0;
		while (headEnd < display.length && indexKey(display[headEnd]?.index) === null) headEnd++;
		if (insertAt <= headEnd && headEnd > 0) {
			return planEdgeMove(rows, source, "top", direction, placement);
		}
		if (headEnd === display.length) {
			return planEdgeMove(rows, source, "top", direction, placement);
		}
	}

	return planDisplayMove(rows, source, beforeDisplay, direction, placement);
}

/**
 * Move an unindexed row to the top or bottom edge of the indexed block.
 * "Top"/"bottom" refer to the indexed block in display order (smallest key at
 * top in ascending, largest key at top in descending), regardless of where
 * unindexed notes are placed.
 */
export function planEdgeMove(
	rows: Row[],
	source: string,
	edge: Edge,
	direction: OrderDirection,
	_placement: UnindexedPlacement = "after",
): IndexWrite[] {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) {
		throw new Error("Duplicate notes in this group.");
	}
	const ordered = sortRows(rows);
	const sourceRow = ordered.find((row) => row.id === source);
	if (!sourceRow) throw new Error("The notes changed. Try the move again.");

	const keys: string[] = [];
	for (const row of ordered) {
		if (row.id === source) continue;
		const key = indexKey(row.index);
		if (key !== null) keys.push(key);
	}

	// Top of indexed block = smallest key in asc, largest key in desc.
	// Bottom of indexed block = largest key in asc, smallest key in desc.
	const atStart = direction === "asc" ? edge === "top" : edge === "bottom";

	let key: string;
	try {
		key = atStart
			? generateKeyBetween(null, keys[0] ?? null)
			: generateKeyBetween(keys[keys.length - 1] ?? null, null);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not create an index at the ${edge} of the indexed notes. ${reason}`,
		);
	}

	if (indexKey(sourceRow.index) === key) return [];
	return [{ id: source, index: key, previous: sourceRow.index }];
}

/**
 * "Balance" action: re-key every indexed row with short, evenly spaced keys.
 * Unindexed rows stay unindexed. This must only run from an explicit user
 * action because it rewrites more notes than a normal move.
 */
export function planBalance(rows: Row[]): IndexWrite[] {
	if (new Set(rows.map((row) => row.id)).size !== rows.length) {
		throw new Error("Duplicate notes in this group.");
	}
	const indexed = sortRows(rows).filter((row) => indexKey(row.index) !== null);
	const keys = generateNKeysBetween(null, null, indexed.length);
	return indexed.flatMap((row, position) => {
		const key = keys[position];
		if (key === undefined || indexKey(row.index) === key) return [];
		return [{ id: row.id, index: key, previous: row.index }];
	});
}

/** Generate one key between two bounds. Kept for callers that need a single key. */
export function keyBetween(left: string | null, right: string | null): string {
	return generateKeyBetween(left, right);
}
