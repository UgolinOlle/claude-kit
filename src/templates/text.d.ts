// Text templates are imported with `with { type: "text" }` and embedded at build time.
declare module '*.tmpl' {
  const content: string;
  export default content;
}
