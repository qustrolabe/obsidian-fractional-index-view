import { describe, it, expect } from "bun:test";
import {
	DEFAULT_INDEX_PROPERTY,
	displayRows,
	indexKey,
	indexProperty,
	keyBetween,
	planBalance,
	planDisplayMove,
	planEdgeMove,
	planMove,
	sameIndexValue,
	sortDirection,
	sortRows,
	type IndexWrite,
	type OrderDirection,
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

/** The displayed order expected after moving `source` before `beforeDisplay`. */
function expectedDisplay(
	rows: Row[],
	source: string,
	beforeDisplay: string | null,
	direction: OrderDirection,
): string[] {
	const canonical = sortRows(rows);
	let canonicalBefore: string | null;
	if (direction === "asc") {
		canonicalBefore = beforeDisplay;
	} else if (beforeDisplay === null) {
		const last = canonical[canonical.length - 1];
		canonicalBefore =
			last && indexKey(last.index) === null
				? null
				: (canonical.filter((entry) => entry.id !== source).find((entry) => indexKey(entry.index) !== null)?.id ??
					null);
	} else {
		const target = canonical.find((entry) => entry.id === beforeDisplay);
		if (!target) throw new Error("missing target");
		if (indexKey(target.index) === null) {
			canonicalBefore = beforeDisplay;
		} else {
			const withoutSource = canonical.filter((entry) => entry.id !== source);
			const index = withoutSource.findIndex((entry) => entry.id === beforeDisplay);
			canonicalBefore = withoutSource[index + 1]?.id ?? null;
		}
	}

	let indexedHeadTarget = false;
	if (direction === "desc") {
		indexedHeadTarget =
			beforeDisplay === null
				? !(canonical[canonical.length - 1] && indexKey(canonical[canonical.length - 1]?.index) === null)
				: indexKey(canonical.find((entry) => entry.id === beforeDisplay)?.index) !== null;
	}

	const desired = canonical.filter((entry) => entry.id !== source);
	const position =
		canonicalBefore === null ? desired.length : desired.findIndex((entry) => entry.id === canonicalBefore);
	if (position < 0) throw new Error("missing target");
	const moved = canonical.find((entry) => entry.id === source);
	if (!moved) throw new Error("missing source");
	desired.splice(position, 0, moved);
	const sourcePosition = position;

	const current = new Map(canonical.map((entry) => [entry.id, indexKey(entry.index)]));
	let suffixStart = desired.length;
	for (let start = 0; start <= desired.length; start++) {
		let valid = true;
		for (let index = start; index < desired.length; index++) {
			const row = desired[index];
			if (!row || current.get(row.id) !== null) {
				valid = false;
				break;
			}
			const previous = index === start ? undefined : desired[index - 1];
			if (previous && previous.id > row.id) {
				valid = false;
				break;
			}
		}
		if (valid) {
			suffixStart = start;
			break;
		}
	}
	if (direction === "desc" && indexedHeadTarget && indexKey(moved.index) === null && suffixStart <= sourcePosition) {
		suffixStart = sourcePosition + 1;
	}

	const result = desired.map((row, index) =>
		index < suffixStart
			? { id: row.id, index: String(index).padStart(4, "0") }
			: { id: row.id, index: undefined },
	);
	return displayRows(result, direction).map((entry) => entry.id);
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

describe("sortDirection and displayRows", () => {
	it("defaults unknown values to ascending", () => {
		expect(sortDirection(undefined)).toBe("asc");
		expect(sortDirection("")).toBe("asc");
		expect(sortDirection("ASC")).toBe("asc");
		expect(sortDirection("desc")).toBe("desc");
	});

	it("reverses indexed rows but keeps unindexed rows after them in descending display", () => {
		const rows = [row("c.md"), row("b.md", "a2"), row("a.md", "a0"), row("d.md", "a1")];
		expect(displayRows(rows, "asc").map((entry) => entry.id)).toEqual([
			"a.md",
			"d.md",
			"b.md",
			"c.md",
		]);
		expect(displayRows(rows, "desc").map((entry) => entry.id)).toEqual([
			"b.md",
			"d.md",
			"a.md",
			"c.md",
		]);
	});
});

describe("planDisplayMove", () => {
	it("matches planMove in ascending display", () => {
		const rows = [row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2")];
		expect(planDisplayMove(rows, "c.md", "b.md", "asc")).toEqual(
			planMove(rows, "c.md", "b.md"),
		);
		expect(planDisplayMove(rows, "a.md", null, "asc")).toEqual(planMove(rows, "a.md", null));
	});

	it("moves a row in descending display", () => {
		const rows = [row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2")];
		// Display is C B A.
		const down = planDisplayMove(rows, "c.md", "a.md", "desc");
		expect(down.map((write) => write.id)).toEqual(["c.md"]);
		expect(displayRows(apply(rows, down), "desc").map((entry) => entry.id)).toEqual([
			"b.md",
			"c.md",
			"a.md",
		]);

		const up = planDisplayMove(rows, "a.md", "b.md", "desc");
		expect(up.map((write) => write.id)).toEqual(["a.md"]);
		expect(displayRows(apply(rows, up), "desc").map((entry) => entry.id)).toEqual([
			"c.md",
			"a.md",
			"b.md",
		]);
	});

	it("returns no writes when the displayed order stays the same", () => {
		const rows = [row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2")];
		expect(planDisplayMove(rows, "c.md", "b.md", "desc")).toEqual([]);
		expect(planDisplayMove(rows, "a.md", null, "desc")).toEqual([]);
	});

	it("moves an unindexed row in descending display", () => {
		const rows = [row("a.md", "a0"), row("b.md"), row("c.md", "a1")];
		// Canonical: A, C, B. Display: C, A, B.
		const toTop = planDisplayMove(rows, "b.md", "c.md", "desc");
		expect(toTop).toHaveLength(1);
		expect(displayRows(apply(rows, toTop), "desc").map((entry) => entry.id)).toEqual([
			"b.md",
			"c.md",
			"a.md",
		]);

		const withinTail = planDisplayMove([row("a.md", "a0"), row("b.md"), row("c.md")], "c.md", "b.md", "desc");
		expect(displayRows(apply([row("a.md", "a0"), row("b.md"), row("c.md")], withinTail), "desc").map((entry) => entry.id)).toEqual([
			"c.md",
			"a.md",
			"b.md",
		]);
	});

	it("reaches the requested display order for every direction and move", () => {
		const groups = [
			[row("a.md"), row("b.md"), row("c.md"), row("d.md")],
			[row("a.md", "a0"), row("b.md", "a1"), row("c.md", "a2"), row("d.md", "a3")],
			[row("a.md", "a0"), row("b.md"), row("c.md", "a1"), row("d.md"), row("e.md", "a2")],
		];
		for (const rows of groups) {
			for (const direction of ["asc", "desc"] as const) {
				const display = displayRows(rows, direction);
				for (const source of display.map((entry) => entry.id)) {
					const targets: (string | null)[] = [
						null,
						...display.map((entry) => entry.id).filter((id) => id !== source),
					];
					for (const beforeDisplay of targets) {
						const writes = planDisplayMove(rows, source, beforeDisplay, direction);
						expect(displayRows(apply(rows, writes), direction).map((entry) => entry.id)).toEqual(
							expectedDisplay(rows, source, beforeDisplay, direction),
						);
					}
				}
			}
		}
	});

	it("rejects duplicates, unknown notes and unknown targets", () => {
		const rows = [row("a.md", "a0"), row("b.md", "a1")];
		expect(() => planDisplayMove([row("a.md"), row("a.md")], "a.md", null, "desc")).toThrow(
			/Duplicate/,
		);
		expect(() => planDisplayMove(rows, "missing.md", null, "desc")).toThrow(/changed/);
		expect(() => planDisplayMove(rows, "a.md", "missing.md", "desc")).toThrow(/changed/);
	});
});

describe("planEdgeMove", () => {
	it("writes only the moved unindexed note at the bottom of indexed rows", () => {
		const rows = [
			row("a.md", "a0"),
			row("b.md", "a1"),
			row("c.md"),
			row("d.md"),
			row("e.md"),
		];
		const writes = planEdgeMove(rows, "d.md", "bottom", "asc");
		expect(writes.map((write) => write.id)).toEqual(["d.md"]);
		expect(displayRows(apply(rows, writes), "asc").map((entry) => entry.id)).toEqual([
			"a.md",
			"b.md",
			"d.md",
			"c.md",
			"e.md",
		]);
	});

	it("uses the opposite key boundary when displaying descending", () => {
		const rows = [
			row("a.md", "a0"),
			row("b.md", "a1"),
			row("c.md"),
			row("d.md"),
			row("e.md"),
		];
		const bottom = planEdgeMove(rows, "d.md", "bottom", "desc");
		expect(bottom.map((write) => write.id)).toEqual(["d.md"]);
		expect(displayRows(apply(rows, bottom), "desc").map((entry) => entry.id)).toEqual([
			"b.md",
			"a.md",
			"d.md",
			"c.md",
			"e.md",
		]);

		const top = planEdgeMove(rows, "d.md", "top", "desc");
		expect(top.map((write) => write.id)).toEqual(["d.md"]);
		expect(displayRows(apply(rows, top), "desc").map((entry) => entry.id)).toEqual([
			"d.md",
			"b.md",
			"a.md",
			"c.md",
			"e.md",
		]);
	});

	it("indexes just the moved note when no rows have keys yet", () => {
		const rows = [row("a.md"), row("b.md"), row("c.md")];
		const writes = planEdgeMove(rows, "c.md", "bottom", "asc");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.id).toBe("c.md");
		expect(indexKey(writes[0]?.index)).not.toBeNull();
	});

	it("never writes the path-sorted unindexed suffix, even for a large group", () => {
		const rows = Array.from({ length: 200 }, (_, index) =>
			row(`note-${String(index).padStart(3, "0")}.md`),
		);
		rows.unshift(row("indexed.md", "a0"));
		const writes = planEdgeMove(rows, "note-199.md", "bottom", "asc");
		expect(writes.map((write) => write.id)).toEqual(["note-199.md"]);
	});

	it("rejects duplicates and unknown notes", () => {
		expect(() => planEdgeMove([row("a.md"), row("a.md")], "a.md", "top", "asc")).toThrow(
			/Duplicate/,
		);
		expect(() => planEdgeMove([row("a.md")], "missing.md", "top", "asc")).toThrow(
			/changed/,
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
