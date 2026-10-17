# The geometry DSL is JSON, validated by zod

**GeneratorDefs** are JSON documents, validated by a zod schema and run by our trusted interpreter. JSON needs no parser, is trivially canonicalised for hashing, can be emitted reliably by Claude with structured output, and validates against the same schema on every device. A small text format would read better for humans but needs a grammar, a parser, and error recovery, and gives nothing the model needs. If humans start writing many generators by hand we can add a text syntax that compiles to this JSON. The JSON stays the source of truth.

Expressions in the DSL are a tiny closed set (`attr`, `num`, `add`, `mul`, `min`, `max`, `clamp`, `rand`, `pick`, `if`…), evaluated by the interpreter. There is no general-purpose code, consistent with invariant 3.
