/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ibm: {
          blue: "#0f62fe",
          dark: "#161616",
          gray: "#262626",
          light: "#f4f4f4"
        }
      }
    },
  },
  plugins: [],
}
