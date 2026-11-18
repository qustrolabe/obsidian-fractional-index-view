import { describe, expect, it } from "bun:test";
import "./obsidian-mock";
import { DEFAULT_INDEX_PROPERTY } from "../src/order";

const { default: FractionalIndexViewPlugin } = await import("../src/main");

function makePlugin() {
	return new (FractionalIndexViewPlugin as any)() as any;
}

describe("plugin registration", () => {
	it("registers the fractional index Bases view", () => {
		const plugin = makePlugin();
		plugin.onload();

		expect(plugin.registerBasesView).toHaveBeenCalledTimes(1);
		const [viewId, registration] = plugin.registerBasesView.mock.calls[0]!;
		expect(viewId).toBe("fractional-index-view");
		expect(registration.name).toBe("Fractional index");
		expect(typeof registration.factory).toBe("function");
		expect(registration.options()[0].default).toBe(DEFAULT_INDEX_PROPERTY);
	});

	it("registers a hover link source for note links", () => {
		const plugin = makePlugin();
		plugin.onload();

		expect(plugin.registerHoverLinkSource).toHaveBeenCalledWith(
			"fractional-index-view",
			{ display: "Fractional Index View", defaultMod: true },
		);
	});
});
