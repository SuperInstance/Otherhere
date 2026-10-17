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
