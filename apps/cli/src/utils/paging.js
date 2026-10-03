import chalk from "chalk";

/**
 * Reading a listing, one page or all of them (imagestep#437, #493).
 *
 * A page is 100 rows and the answer says whether there is another and where it starts (`meta.nextCursor`), so
 * "give me everything" is four lines — and four lines every script would write slightly differently, one of them off
 * by one. `--all` is those four lines, and they are the SDK's: each listing's `iterate…` follows the cursor the answer
 * carries, never a page number (page 1 000 by number makes the service read and throw away 99 900 rows and count the
 * filter again), and fails rather than stopping halfway when `hasMore` comes without a cursor.
 * `imagestep asset list --all -o json` is the whole library as one array, which is what a pipe into `jq` wanted.
 */

/**
 * `--all` walks from the first page and `--cursor` names where a page starts, so a `--page` beside either can only be
 * a mistake about what one of them does. (`--cursor` with `--all` is fine: it resumes a walk.) A usage error, so exit 1
 * like every other one (#566) — it carried an `exitCode: 2` nothing read, and 2 is `jobs wait`'s timeout.
 */
export function checkPagingOptions(options, command) {
  const pageGiven = command?.getOptionValueSource?.("page") === "cli";
  if (options.all && pageGiven) throw new Error("--all reads every page; drop --page, or drop --all to read one.");
  if (options.cursor && pageGiven) throw new Error("--cursor already says where the page starts; drop --page.");
}

/**
 * One page, or every page when `--all`, read through one SDK listing: `list` is its one-page method, `iterate` its walk.
 * `params` carries the command's own filters and its `perPage`; where the page starts is set here — `--page`, or
 * `--cursor`, and with `--all` from page 0 unless a cursor resumes it.
 *
 * Returns `{ rows, meta }`. With `--all`, `meta` describes what the caller is holding, not the last request: `total` is
 * the rows read (none when a `--cursor` resumed the walk part-way), `hasMore` false.
 *
 * @param {{ list: (params: object) => Promise<{ items: any[], meta: object }>, iterate: (params: object) => AsyncIterable<any> }} listing
 */
export async function readListing({ list, iterate }, params, options) {
  const start = options.cursor ? { cursor: options.cursor } : { page: options.all ? 0 : options.page };
  if (!options.all) {
    const { items, meta } = await list({ ...start, ...params });
    return { rows: items || [], meta: meta || {} };
  }
  const rows = [];
  for await (const row of iterate({ ...start, ...params })) rows.push(row);
  return {
    rows,
    meta: { total: options.cursor ? undefined : rows.length, page: 0, perPage: rows.length, hasMore: false, nextCursor: null }
  };
}

/** On stderr after one page that is not the last: the flag that reads the next. Silent with `--all`. */
export function printContinuation(meta, options) {
  if (!options.all && meta.hasMore && meta.nextCursor) {
    console.error(chalk.gray(`\nMore: --cursor ${meta.nextCursor}`));
  }
}
