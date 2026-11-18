import { mock } from "bun:test";

// Plugin code uses window.* timers (obsidianmd lint rule); provide a window
// alias so tests running under Bun (which has none) behave like Obsidian.
(globalThis as any).window = globalThis;

// Single shared Obsidian mock to avoid order-dependent test failures.
void mock.module("obsidian", () => ({
	App: class {},
	BasesView: class {
		constructor(_controller: any) {}
	},
	Modal: class {},
	Notice: class {
		constructor(_message: string) {}
	},
	Plugin: class {
		registerHoverLinkSource = mock(() => {});
		registerBasesView = mock(() => true);
	},
	TFile: class {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	},
	setIcon: mock(() => {}),
}));
