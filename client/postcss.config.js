/**
 * PostCSS configuration — required for Tailwind CSS to process
 * the `@tailwind` directives in globals.css under Next.js.
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
