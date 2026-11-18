import { describe, expect, it } from "bun:test";
import { DEFAULT_INDEX_PROPERTY, INDEX_PROPERTY_OPTION } from "../src/order";
import { viewOptions } from "../src/view-options";

describe("viewOptions", () => {
	it("exposes one text option for the index property", () => {
		const options = viewOptions();
		expect(options).toHaveLength(1);
		expect(options[0]).toEqual({
			type: "text",
			key: INDEX_PROPERTY_OPTION,
			displayName: "Index property",
			default: DEFAULT_INDEX_PROPERTY,
			placeholder: DEFAULT_INDEX_PROPERTY,
		});
	});
});
