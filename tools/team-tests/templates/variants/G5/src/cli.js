#!/usr/bin/env node
// Command line entry: prints a labelled price. Usage: node src/cli.js <name> <cents>
// Planted Minor: the next line has a typo ("recieves"); the CLI recieves two positional arguments.
// Planted Major: parseArgs does no input validation (a missing or non-numeric amount prints "$NaN").
import { label } from './index.js';

export function parseArgs(argv) {
  const [name, cents] = argv;
  return { name, cents: Number(cents) };
}

export function run(argv) {
  const { name, cents } = parseArgs(argv);
  return label(name, cents);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(`${run(process.argv.slice(2))}\n`);
}
