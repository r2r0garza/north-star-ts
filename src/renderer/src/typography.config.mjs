// Tailwind Typography overrides, loaded from globals.css via @config.
//
// Both replace selectors that make the browser restyle a whole .prose block
// whenever an element is added to it — i.e. on every update of a streaming
// reply, at a cost that grows with the reply. Rendered output is unchanged.
//
// - `blockquote p:first-of-type::before` / `p:last-of-type::after`: the browser
//   tests `p:last-of-type` on every <p> before looking for a blockquote, which
//   marks the container as depending on its children's order. :first-child /
//   :last-child quote the same paragraphs (except a paragraph that follows a
//   list inside a quote) and only ever restyle the old and new first/last child.
// - `h2 + *` (and h3, h4, hr): a universal sibling subject makes every inserted
//   element invalidate the container's whole subtree. Naming the block-level
//   elements Markdown renders keeps the invalidation to the inserted element.

const FOLLOWERS =
  ":where(p, h1, h2, h3, h4, h5, h6, ul, ol, dl, blockquote, pre, div, table, hr, section, figure, img, picture, video)"

const afterHeadings = Object.fromEntries(
  ["hr", "h2", "h3", "h4"].flatMap((tag) => [
    [`${tag} + *`, null],
    [`${tag} + ${FOLLOWERS}`, { marginTop: "0" }],
  ])
)

export default {
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            "blockquote p:first-of-type::before": null,
            "blockquote p:last-of-type::after": null,
            "blockquote p:first-child::before": { content: "open-quote" },
            "blockquote p:last-child::after": { content: "close-quote" },
            ...afterHeadings,
          },
        },
        // prose-sm repeats the heading-sibling rules with its own spacing.
        sm: { css: afterHeadings },
      },
    },
  },
}
