import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only run files in test/. The src/ tree contains a legacy script-style
        // black-scholes.test.ts that uses raw assertions, not vitest format.
        include: ['test/**/*.test.ts'],
    },
});
