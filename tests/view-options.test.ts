import { describe, expect, it } from "bun:test";
import {
	DEFAULT_INDEX_PROPERTY,
	INDEX_PROPERTY_OPTION,
	SORT_DIRECTION_OPTION,
} from "../src/order";
import { viewOptions } from "../src/view-options";

describe("viewOptions", () => {
	it("exposes the index property text option", () => {
		const options = viewOptions();
		expect(options).toHaveLength(2);
		expect(options[0]).toEqual({
			type: "text",
			key: INDEX_PROPERTY_OPTION,
			displayName: "Index property",
			default: DEFAULT_INDEX_PROPERTY,
			placeholder: DEFAULT_INDEX_PROPERTY,
		});
	});

	it("exposes a persisted sort direction dropdown", () => {
		expect(viewOptions()[1]).toEqual({
			type: "dropdown",
			key: SORT_DIRECTION_OPTION,
			displayName: "Sort direction",
			default: "asc",
			options: {
				asc: "Ascending",
				desc: "Descending",
			},
		});
	});
});
