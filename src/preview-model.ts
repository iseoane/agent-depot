/** One row of a preview item; renderers choose the wording and colour of each kind. */
export type PreviewRow =
  | { readonly kind: "field"; readonly label: string; readonly value: string }
  | { readonly kind: "text"; readonly text: string; readonly indent?: number }
  | { readonly kind: "warning"; readonly text: string }
  | {
    readonly kind: "command";
    readonly argv: readonly string[];
    /** The resolved executable; absent when it was not found in PATH. */
    readonly executable?: string;
    readonly cwd?: string;
  };

/** One Skill, App or Package of a preview. */
export interface PreviewItem {
  readonly title: string;
  /** Where the item comes from, shown dimmed after the title. */
  readonly detail?: string;
  readonly version?: { readonly from: string; readonly to: string };
  readonly rows: readonly PreviewRow[];
}

export interface PreviewSection {
  readonly heading: string;
  readonly items: readonly PreviewItem[];
}

/** A whole preview: what confirming does, the warnings to read first, the items by type and what could not be previewed. */
export interface PreviewDocument {
  readonly action: string;
  /** Counts per type, such as `1 Skill · 1 App`. */
  readonly summary: string;
  /** Where the whole batch applies, such as the project root. */
  readonly context: readonly string[];
  /** Warnings that belong to no item; item warnings are collected from their rows. */
  readonly warnings: readonly string[];
  readonly sections: readonly PreviewSection[];
  readonly failures: readonly string[];
}

// Anything outside this set could be read differently by a shell, so the argument is shown quoted.
const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/u;

// What the TUI does not escape itself: spaces other than U+0020, default-ignorable code points that are not control or format, and
// the zero-width joiner (kept in ordinary text for emoji).
const NOT_ESCAPED_BY_TUI = /(?! )(?![\p{Cc}\p{Cf}])[\p{Zs}\p{Default_Ignorable_Code_Point}]|\u200D/gu;
// JSON.stringify leaves these raw; shown as is, a right-to-left override, zero-width space or no-break space can make one argument
// look like another. A plain space stays: inside the quotes it is what it looks like.
const INVISIBLE = /(?! )[\p{Cc}\p{Cf}\p{Zs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

function quoted(argument: string, terminal: boolean): string {
  // The TUI escapes control and format characters once, when it draws; escaping them here too would show a real RLO as typed text.
  if (terminal) return quoteText(argument).replace(NOT_ESCAPED_BY_TUI, escapeCharacter);
  return JSON.stringify(argument).replace(INVISIBLE, escapeCharacter);
}

function escapeCharacter(character: string): string {
  const code = character.codePointAt(0)!.toString(16);
  return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, "0")}`;
}

/** `text` in double quotes with quotes and backslashes escaped; control characters stay as they are for the TUI to escape. */
export function quoteText(text: string): string {
  return `"${text.replace(/[\\"]/gu, "\\$&")}"`;
}

/**
 * The argv as one shell-like line: arguments with spaces, quotes, shell metacharacters or invisible characters are JSON-quoted.
 * With `terminal`, control and format characters are left for the TUI's own escaping.
 */
export function commandLine(argv: readonly string[], options: { readonly terminal?: boolean } = {}): string {
  const terminal = options.terminal === true;
  return argv.map((argument) => PLAIN_ARGUMENT.test(argument) ? argument : quoted(argument, terminal)).join(" ");
}

/** Every warning row of the item, in order. */
export function itemWarnings(item: PreviewItem): readonly string[] {
  return item.rows.flatMap((row) => row.kind === "warning" ? [row.text] : []);
}
