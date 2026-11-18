import { Plugin } from "obsidian";
import { FractionalIndexView } from "./view";
import { viewOptions } from "./view-options";

export default class FractionalIndexViewPlugin extends Plugin {
	onload(): void {
		this.registerHoverLinkSource("fractional-index-view", {
			display: "Fractional Index View",
			defaultMod: true,
		});

		this.registerBasesView("fractional-index-view", {
			name: "Fractional index",
			icon: "list-ordered",
			factory: (controller, container) => new FractionalIndexView(controller, container),
			options: viewOptions,
		});
	}
}
