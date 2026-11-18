Obsidian plugin that adds custom Bases view that lets you order notes using fractional-indexing.

Inspired by [theluckystrike/bases-manual-order](https://github.com/theluckystrike/bases-manual-order) but uses [fractional-indexing](https://www.npmjs.com/package/fractional-indexing) strings instead of numbers.

When you have notes with indexes `a0` and `a2` it's obvious that `a1` would go between them lexicographically. But when we want to add note between `a0` and `a1` we can just append new character to have index `a0V`, this lets us place infinitely many notes between any two and still get proper sort order.

> [!WARNING]
> this extension is still too fresh and needs more polishing, make sure you do regular backups of your vault
>
> tapping into Obsidian's Bases custom views API is a little bit janky and doesn't let me do some things properly yet, there's no guarantee this plugin will continue being Bases extension and I may move it into its own thing entirely
