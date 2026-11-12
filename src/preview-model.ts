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

// JSON.stringify leaves these raw; shown as is, a right-to-left override, zero-width space or no-break space can make one argument
// look like another. A plain space stays: inside the quotes it is what it looks like.
const INVISIBLE = /(?! )[\p{Cc}\p{Cf}\p{Zs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

function quoted(argument: string): string {
  return JSON.stringify(argument).replace(INVISIBLE, (character) => {
    const code = character.codePointAt(0)!.toString(16);
    return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, "0")}`;
  });
}

/** The argv as one shell-like line: arguments with spaces, quotes, shell metacharacters or invisible characters are JSON-quoted. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((argument) => PLAIN_ARGUMENT.test(argument) ? argument : quoted(argument)).join(" ");
}

/** Every warning row of the item, in order. */
export function itemWarnings(item: PreviewItem): readonly string[] {
  return item.rows.flatMap((row) => row.kind === "warning" ? [row.text] : []);
}
