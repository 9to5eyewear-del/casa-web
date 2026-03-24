# Design System: The Editorial Villa

## 1. Overview & Creative North Star
**Creative North Star: "The Curated Canvas"**

This design system is not a digital interface; it is a high-end editorial publication brought to life. Moving away from the rigid, "boxy" structures of standard web design, "The Curated Canvas" prioritizes breathability, intentional asymmetry, and tactile depth. We lean into the *Italian Villa* aesthetic—where stone meets silk, and sunlight softens every edge. 

The goal is to evoke the feeling of walking through an airy boutique. We break the "template" look by utilizing wide margins, overlapping image-to-text elements, and a typographic scale that values "white space" as a primary design element rather than a void to be filled.

---

## 2. Colors: Tonal Sophistication
The palette is a study in neutrals, designed to feel warm, feminine, and expensive. We avoid "pure" blacks and golds, opting instead for the depth of charcoal and the softness of stone.

### The Palette (Material Tokens)
- **Base (Surface/Background):** `#faf9f6` (Ivory/Stone). This is your primary canvas.
- **Accents:** Secondary/Tertiary tones like `#5f6051` (Olive/Sage) are used sparingly for active states or subtle callouts.
- **Typography:** `on_surface` (`#2f3430`) provides a soft charcoal contrast that is easier on the eye than pure black.

### The "No-Line" Rule
**Explicit Instruction:** Do not use 1px solid borders to section content. Traditional "dividers" are strictly prohibited. 
- Boundaries must be defined through **Background Color Shifts**. For example, a `surface-container-low` section should sit directly against a `surface` background to create a logical break without a harsh line.
- Use **Vertical White Space** (Refer to Spacing Scale 16 or 20) to signal the end of a content block.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers—like stacked sheets of fine Italian stationery.
- **Base Layer:** `surface` (#faf9f6)
- **Secondary Layer:** `surface-container-low` (#f4f4f0) for subtle grouping.
- **High Importance:** `surface-container-highest` (#e0e4de) for featured cards or modals.
By nesting a `surface-container-lowest` (#ffffff) card inside a `surface-container-low` section, you create a natural "lift" that feels architectural rather than digital.

### The "Glass & Gradient" Rule
To add "soul," use subtle gradients for Hero backgrounds transitioning from `primary` to `primary-container`. For floating navigation or overlays, apply **Glassmorphism**: use semi-transparent surface colors with a `backdrop-blur` (12px–20px) to let the "villa light" bleed through.

---

## 3. Typography: The Editorial Voice
Typography is our primary tool for conveying luxury. We pair a high-contrast Serif with a modern, breathable Sans-serif.

- **Display & Headlines (Newsreader):** This is our "Editorial" voice. It should be used with generous leading. Headlines should feel like titles in a fashion magazine.
    - *Tip:* Use `display-lg` for hero statements, and don't be afraid of asymmetrical placement (e.g., left-aligned text with a 20% right margin).
- **Body & Titles (Plus Jakarta Sans):** This is our "Functional" voice. It is clean, airy, and highly readable. 
    - *Tip:* Increase letter-spacing slightly (0.02em) on `label-md` and `label-sm` to enhance the premium boutique feel.

---

## 4. Elevation & Depth: Tonal Layering
We reject the heavy drop-shadows of the 2010s. Depth is achieved through light and atmospheric layering.

- **Layering Principle:** Stack `surface-container` tiers. A `surface-container-lowest` card on a `surface-container-low` background creates a soft, natural lift.
- **Ambient Shadows:** If an element must float (e.g., a "Book Now" CTA), use a shadow with a blur radius of 40px+ and an opacity of 4%–6%. The shadow color must be a tint of the `on-surface` color (#2f3430), never pure grey.
- **The "Ghost Border" Fallback:** If a border is required for accessibility, use the `outline-variant` token at **15% opacity**. It should be felt, not seen.

---

## 5. Components: Boutique Implementation

### Buttons
- **Primary:** High-contrast `primary` (#625e51) with `on_primary` text. No rounded-pill shapes; use `rounded-sm` (0.125rem) for a sharp, architectural look.
- **Tertiary:** Text-only with a 1px `underline` that appears only on hover. This mimics editorial links in high-end blogs.

### Cards
- **The Layout:** No borders, no shadows. Use a subtle background shift (`surface-container-low`) and generous internal padding (Spacing 6 or 8). 
- **Imagery:** Images should have a slight `rounded-sm` corner to soften them, mimicking printed photos.

### Input Fields
- **Style:** Minimalist. A single bottom-border using `outline-variant` at 40% opacity. Labels (`label-md`) should sit above the field in all-caps with increased tracking.

### Navigation (Mobile-First)
- Use a **Floating Glass Dock** for mobile navigation. A semi-transparent `surface` blur that sits at the bottom of the screen, allowing the content to scroll elegantly behind it.

### Editorial Add-on: The "Signature Image Overlay"
A custom component where a small image (e.g., a detail shot of lace or stone) overlaps a larger lifestyle image by 15%, creating a collage-like, scrapbooked feel that is synonymous with bridal mood boards.

---

## 6. Do's and Don'ts

### Do:
- **Use Asymmetry:** Place a heading on the left and a paragraph on the right with a large vertical offset.
- **Embrace White Space:** If you think there is enough space, add 20% more. 
- **Focus on Micro-interactions:** Transitions between pages should be soft "fades" or "slides" to mimic the turning of a heavy paper page.

### Don't:
- **Don't use Dividers:** Never use a horizontal line to separate sections. Use a 4rem (`spacing-12`) gap instead.
- **Don't use Boxy Grids:** Avoid the "3-column card row" look. Try a "2-column staggered" layout where one card is slightly lower than the other.
- **Don't use Pure Black:** It breaks the "Quiet Luxury" softness. Always stick to the `on_surface` charcoal.
- **Don't use Heavy Shadows:** If a shadow looks like a shadow, it’s too dark. It should look like a natural occlusion of light.