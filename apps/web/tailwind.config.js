// Colours are NOT here. A colour defined in this file compiles to a literal
// hex in every utility, so it cannot follow the light/dark mode. Every colour,
// the neon family included, is a role variable in app/theme.css, mapped to
// Tailwind there by `@theme inline` (NEO-356).
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Lexend', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
