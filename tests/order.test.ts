import { describe, it, expect } from "bun:test";
import {
	DEFAULT_INDEX_PROPERTY,
	indexKey,
	indexProperty,
	keyBetween,
	planBalance,
	planMove,
	sameIndexValue,
	sortRows,
	type IndexWrite,
	type Row,
} from "../src/order";

function row(id: string, index?: unknown): Row {
	return index === undefined ? { id, index: undefined } : { id, index };
}

function ids(rows: Row[]): string[] {
	return sortRows(rows).map((entry) => entry.id);
}

function apply(rows: Row[], writes: IndexWrite[]): Row[] {
	const byId = new Map(writes.map((write) => [write.id, write.index]));
	return rows.map((entry) => ({
		...entry,
		index: byId.has(entry.id) ? byId.get(entry.id) : entry.index,
	}));
}

/** The order the view expects after moving `source` before `before`. */
function expected(rows: Row[], source: string, before: string | null): string[] {
	const current = sortRows(rows);
	const moved = current.find((entry) => entry.id === source);
	if (!moved) throw new Error("missing source");
	const next = current.filter((entry) => entry.id !== source);
	const position = before === null ? next.length : next.findIndex((entry) => entry.id === before);
	next.splice(position, 0, moved);
	return next.map((entry) => entry.id);
}

describe("indexProperty", () => {
	it("defaults to fractional_index", () => {
		expect(indexProperty(undefined)).toBe(DEFAULT_INDEX_PROPERTY);
		expect(indexProperty("")).toBe(DEFAULT_INDEX_PROPERTY);
		expect(indexProperty("   ")).toBe(DEFAULT_INDEX_PROPERTY);
	});

	it("trims values and accepts a pasted note property id", () => {
		expect(indexProperty("  my_order  ")).toBe("my_order");
		expect(indexProperty("note.fractional_index")).toBe("fractional_index");
	});

	it("accepts dashes and underscores", () => {
		expect(indexProperty("_index-2")).toBe("_index-2");
	});

	it("rejects invalid or reserved names", () => {
		expect(() => indexProperty("file.name")).toThrow();
		expect(() => indexProperty("contains space")).toThrow();
		expect(() => indexProperty("__proto__")).toThrow();
		expect(() => indexProperty(42)).toThrow();
	});
});

describe("indexKey", () => {
	it("returns null for empty values", () => {
		expect(indexKey(undefined)).toBeNull();
		expect(indexKey(null)).toBeNull();
		expect(indexKey("")).toBeNull();
		expect(indexKey("   ")).toBeNull();
	});

	it("trims string keys", () => {
		expect(indexKey(" a0 ")).toBe("a0");
	});

	it("rejects non-string values", () => {
		expect(() => indexKey(1)).toThrow(/non-string/);
		expect(() => indexKey({})).toThrow(/non-string/);
	});
});

describe("sameIndexValue", () => {
	it("treats empty representations as equal", () => {
		expect(sameIndexValue(undefined, null)).toBe(true);
		expect(sameIndexValue("", null)).toBe(true);
		expect(sameIndexValue(" a0 ", "a0")).toBe(true);
	});

	it("distinguishes different keys", () => {
		expect(sameIndexValue("a0", "a1")).toBe(false);
		expect(sameIndexValue(undefined, "a0")).toBe(false);
	});
});

describe("sortRows", () => {
	it("sorts indexed rows lexicographically, then unindexed rows by path", () => {
		expect(
			ids([
				row("c.md"),
				row("b.md", "a2"),
				row("a.md", "a0"),
				row("d.md", "a1"),
			]),
		).toEqual(["a.md", "d.md", "b.md", "c.md"]);
	});

	it("uses the path as a stable tie breaker for equal keys", () => {
		expect(ids([row("b.md", "a0"), row("a.md", "a0")])).toEqual(["a.md", "b.md"]);
	});

	it("does not mutate the input", () => {
		const rows = [row("b.md", "a1"), row("a.md", "a0")];
		ids(rows);
		expect(rows.map((entry) => entry.id)).toEqual(["b.md", "a.md"]);
	});
});

describe("planMove with indexed rows", () => {
	const rows = [row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2")];

	it("returns no writes when the order does not change", () => {
		expect(planMove(rows, "a.md", "b.md")).toEqual([]);
		expect(planMove(rows, "a.md", "a.md")).toEqual([]);
	});

	it("writes only the moved row when it lands between two keys", () => {
		const writes = planMove(rows, "c.md", "b.md");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.id).toBe("c.md");
		expect(writes[0]?.previous).toBe("a2");
		expect(ids(apply(rows, writes))).toEqual(["a.md", "c.md", "b.md"]);
	});

	it("moves a row to the top", () => {
		const writes = planMove(rows, "c.md", "a.md");
		expect(writes).toHaveLength(1);
		expect(ids(apply(rows, writes))).toEqual(["c.md", "a.md", "b.md"]);
	});

	it("moves a row to the bottom", () => {
		const writes = planMove(rows, "a.md", null);
		expect(writes).toHaveLength(1);
		expect(ids(apply(rows, writes))).toEqual(["b.md", "c.md", "a.md"]);
	});

	it("rejects duplicate or unknown notes", () => {
		expect(() => planMove([row("a.md", "a0"), row("a.md", "a1")], "a.md", null)).toThrow(
			/Duplicate/,
		);
		expect(() => planMove(rows, "missing.md", null)).toThrow(/changed/);
		expect(() => planMove(rows, "a.md", "missing.md")).toThrow(/changed/);
	});
});

describe("planMove with empty indexes", () => {
	const rows = [row("a.md"), row("b.md"), row("c.md"), row("d.md")];

	it("indexes only the moved row when moving to the top", () => {
		const writes = planMove(rows, "c.md", "a.md");
		expect(writes.map((write) => write.id)).toEqual(["c.md"]);
		expect(ids(apply(rows, writes))).toEqual(["c.md", "a.md", "b.md", "d.md"]);
	});

	it("indexes the shortest necessary prefix when moving into the middle", () => {
		const writes = planMove(rows, "c.md", "b.md");
		expect(writes.map((write) => write.id)).toEqual(["a.md", "c.md"]);
		expect(ids(apply(rows, writes))).toEqual(["a.md", "c.md", "b.md", "d.md"]);
	});

	it("indexes the shortest necessary prefix when moving to the bottom", () => {
		const writes = planMove(rows, "a.md", null);
		expect(writes.map((write) => write.id)).toEqual(["b.md", "c.md", "d.md"]);
		expect(ids(apply(rows, writes))).toEqual(["b.md", "c.md", "d.md", "a.md"]);
	});

	it("never indexes the untouched path-sorted suffix", () => {
		const writes = planMove(rows, "d.md", "b.md");
		expect(writes.map((write) => write.id)).toEqual(["a.md", "d.md"]);
		expect(ids(apply(rows, writes))).toEqual(["a.md", "d.md", "b.md", "c.md"]);
	});
});

describe("planMove with mixed indexed and empty rows", () => {
	it("uses an indexed neighbour as an anchor", () => {
		const rows = [row("a.md", "a0"), row("b.md"), row("c.md", "a1")];
		const writes = planMove(rows, "b.md", "a.md");
		expect(writes.map((write) => write.id)).toEqual(["b.md"]);
		expect(ids(apply(rows, writes))).toEqual(["b.md", "a.md", "c.md"]);
	});

	it("leaves indexed neighbours untouched", () => {
		const rows = [row("a.md", "a0"), row("b.md"), row("c.md", "a2")];
		const writes = planMove(rows, "b.md", "c.md");
		expect(writes.map((write) => write.id)).toEqual(["b.md"]);
		expect(ids(apply(rows, writes))).toEqual(["a.md", "b.md", "c.md"]);
	});
});

describe("planMove invariants", () => {
	it("reaches the requested order for every unindexed move", () => {
		const rows = ["a", "b", "c", "d", "e"].map((id) => row(`${id}.md`));
		for (const source of rows.map((entry) => entry.id)) {
			const targets: (string | null)[] = [
				null,
				...rows.map((entry) => entry.id).filter((id) => id !== source),
			];
			for (const before of targets) {
				const writes = planMove(rows, source, before);
				expect(ids(apply(rows, writes))).toEqual(expected(rows, source, before));
			}
		}
	});

	it("reaches the requested order with a sparse existing index", () => {
		const rows = [
			row("a.md", "a0"),
			row("b.md"),
			row("c.md", "a1"),
			row("d.md"),
			row("e.md", "a2"),
		];
		for (const source of rows.map((entry) => entry.id)) {
			const targets: (string | null)[] = [
				null,
				...rows.map((entry) => entry.id).filter((id) => id !== source),
			];
			for (const before of targets) {
				const writes = planMove(rows, source, before);
				expect(ids(apply(rows, writes))).toEqual(expected(rows, source, before));
			}
		}
	});

	it("writes one note in the common indexed case", () => {
		const rows = [row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2")];
		for (const source of rows.map((entry) => entry.id)) {
			for (const before of [null, ...rows.map((entry) => entry.id)]) {
				if (before === source) continue;
				const writes = planMove(rows, source, before);
				if (ids(apply(rows, writes)).join() !== ids(rows).join()) {
					expect(writes.length).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	it("refuses to overwrite a non-string value", () => {
		expect(() => planMove([row("a.md", 12), row("b.md", "a0")], "b.md", "a.md")).toThrow(
			/non-string/,
		);
	});
});

describe("planBalance", () => {
	it("re-keys every row with short ascending keys", () => {
		const rows = [
			row("a.md", "a0V"),
			row("b.md"),
			row("c.md", "Zz"),
		];
		const writes = planBalance(rows);
		expect(writes).toHaveLength(3);
		const balanced = apply(rows, writes);
		expect(ids(balanced)).toEqual(ids(rows));
		const keys = sortRows(balanced).map((entry) => entry.index);
		expect(keys).toEqual(["a0", "a1", "a2"]);
	});

	it("returns no writes when the rows already have canonical keys", () => {
		expect(planBalance([row("a.md", "a0"), row("b.md", "a1")])).toEqual([]);
	});

	it("handles an empty group", () => {
		expect(planBalance([])).toEqual([]);
	});

	it("rejects duplicates", () => {
		expect(() => planBalance([row("a.md"), row("a.md")])).toThrow(/Duplicate/);
	});
});

describe("keyBetween", () => {
	it("creates keys between two bounds", () => {
		const middle = keyBetween("a0", "a1");
		expect(middle > "a0").toBe(true);
		expect(middle < "a1").toBe(true);
	});

	it("creates the first key", () => {
		expect(keyBetween(null, null)).toBe("a0");
	});
});
