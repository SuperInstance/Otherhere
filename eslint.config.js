import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Invariant 3: never execute model-written code.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Play-test probes are Node scripts, not browser code: they need Node and
    // browser globals both, and the Function constructor is never used anyway.
    files: ['apps/client/playtest/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: { 'no-new-func': 'off' },
  },
  {
    // Invariant 2: determinism. Geometry code must use our deterministic math.
    files: ['packages/core/src/geometry/**/*.ts', 'packages/core/src/math/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['sin', 'cos', 'tan', 'atan', 'atan2', 'pow', 'exp', 'log', 'random', 'hypot'].map(
          (p) => ({ object: 'Math', property: p, message: 'Use deterministic math (ADR-0006).' }),
        ),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='**']",
          message: 'Use deterministic math (ADR-0006).',
        },
      ],
    },
  },
);
