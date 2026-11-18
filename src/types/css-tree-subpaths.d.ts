// css-tree 3 exports these entry points; @types/css-tree only declares the root.
declare module "css-tree/tokenizer" {
  export { tokenize, tokenTypes } from "css-tree"
}

declare module "css-tree/utils" {
  export { ident, string, url } from "css-tree"
}
