# Pete Fixes — Wix Implementation Guide

This guide maps every section of the redesigned HTML/CSS to Wix Editor components so you can rebuild the site natively in Wix.

---

## 1. Global Settings (Site-Wide)

### Fonts
- **Primary font:** Inter (available in Wix fonts)
- **Secondary font:** DM Sans (upload via Wix > Site Fonts > Upload Font)
- Fallback: system default sans-serif

### Color Palette (set in Site Design > Colors)
| Name         | Hex       | Usage                          |
|-------------|-----------|--------------------------------|
| White       | `#FBFBFD` | Page backgrounds               |
| Black       | `#1D1D1F` | Headings, body text            |
| Gray-50     | `#F5F5F7` | Light section backgrounds      |
| Gray-400    | `#86868B` | Subtle labels                  |
| Gray-500    | `#6E6E73` | Body text, subtitles           |
| Accent Gold | `#C8A55A` | CTAs, eyebrow text, highlights |
| Accent Hover| `#B8953A` | Button hover states            |

### Navigation (Header)
- Use **Wix Header** with a **Transparent/Frosted** style
- Set background: `rgba(251, 251, 253, 0.72)` with blur effect
- Height: **52px**
- Layout: Logo (left) | Nav Links (center) | Phone Number (right, gold color)
- Nav links: **Services**, **Gallery**, **Contact** — 13px Inter Medium
- Enable **Sticky Header** (scrolls with page)
- Phone number: `204-894-9071` in gold (`#C8A55A`), linked to `tel:2048949071`

---

## 2. Hero Section

### Wix Component: **Strip** (full-width section)
- Background: `#FBFBFD` (white)
- Padding: 140px top, 80px bottom

### Content Layout
- Use a **single column** layout (not side-by-side)
- **Eyebrow text:** "WINNIPEG'S TRUSTED SECURITY & GATE EXPERTS"
  - 14px Inter SemiBold, uppercase, letter-spacing 0.04em, gold color
- **Heading (H1):** "build. secure." (new line) "fixes."
  - 72px Inter Bold, letter-spacing -0.04em
  - "fixes." in gold color
- **Subtitle:** "Custom fencing from the ground up..."
  - 19px Inter Regular, gray-500 color, max-width 600px
- **Buttons (horizontal row):**
  - "Get a Free Quote" — gold pill button (border-radius 980px)
  - "Explore Services" — gold outline pill button

### Hero Image
- Below the text content, full-width container
- Use a **Wix Image** element with rounded corners (20px)
- Add a subtle shadow
- **Replace with your actual gate/fence installation photo**

---

## 3. Services Intro Section

### Wix Component: **Strip** (full-width)
- Background: transparent/white
- Padding: 120px top, 80px bottom
- **Text alignment:** Center

### Content
- **Eyebrow:** "WHAT WE DO" — gold, 14px, uppercase
- **Heading (H2):** "Security solutions built around you."
  - 56px Inter Bold, tight letter-spacing
- **Subtitle:** gray-500, max-width 560px, centered

---

## 4. Service Blocks (x4)

Each service block alternates between **dark** and **light** backgrounds.

### Block Pattern

| # | Service            | Background    | Content Side |
|---|--------------------|---------------|-------------|
| 1 | Automatic Gates    | Black `#1D1D1F` | Left        |
| 2 | Fencing            | Gray `#F5F5F7`  | Right       |
| 3 | Access Control     | Black `#1D1D1F` | Left        |
| 4 | Security Solutions | Gray `#F5F5F7`  | Right       |

### Wix Component: **Strip** with **Columns** (2-column, 50/50)
- Padding: 100px top/bottom

### Content Column
- **Eyebrow:** Service name in gold, 14px uppercase
- **Heading (H3):** Two-line tagline, 44px Inter Bold
  - White text on dark sections, black on light
- **Description:** 16px, gray-300 (dark) or gray-500 (light)
- **Feature list:** Use a text block with `+` prefix on each line in gold
- **CTA Button:** pill-shaped, gold (dark sections) or black (light sections)

### Image Column
- **2-image grid** for Gates, Access Control, Security
- **3-image grid** for Fencing
- Use **Wix Pro Gallery** or individual image boxes
- Rounded corners: 14px
- Images should be your actual project photos

---

## 5. "Why Pete Fixes" Section

### Wix Component: **Strip** (full-width)
- Background: white
- Padding: 120px top/bottom
- Text alignment: center

### Layout
- **Eyebrow + Heading** centered at top
- **4-column grid** below (use Wix Columns, equal width)

### Each Card
- **Icon:** Use Wix vector icons or upload SVGs (48x48, gold stroke icons)
- **Title:** 18px Inter SemiBold
- **Description:** 14px, gray-500
- Cards: Expert Installation, Emergency Repairs, Customer First, Full-Service

---

## 6. Gallery Section

### Wix Component: **Strip** with **Pro Gallery**
- Background: black `#1D1D1F`
- Padding: 120px top/bottom

### Content
- **Eyebrow:** "OUR WORK" — gold
- **Heading:** "See it in action." — white
- **Subtitle:** gray-400

### Gallery Grid
- Use **Wix Pro Gallery** in Grid layout
- 4 columns, first item spans 2 columns + 2 rows
- Rounded corners on images (14px)
- Hover effect: slight scale (1.02)
- **Upload your actual project photos**

---

## 7. CTA Banner

### Wix Component: **Strip**
- Background: dark gradient (use Wix gradient tool, black to near-black)
- Padding: 100px top/bottom
- Text alignment: center

### Content
- **Heading:** "Ready to secure your property?" — white, 48px
- **Subtitle:** gray-300, 18px
- **Two buttons (horizontal):**
  - "Get Your Free Quote" — gold pill, larger (17px, more padding)
  - "Call 204-894-9071" — ghost/outline pill (white text, subtle border)

---

## 8. Contact Section

### Wix Component: **Strip** with **Columns** (2-column)
- Background: `#F5F5F7`
- Padding: 120px top/bottom

### Left Column — Info
- **Eyebrow:** "GET IN TOUCH" — gold
- **Heading:** "Let's talk about your project."
- **Description paragraph**
- **Contact details list:**
  - Emergency Line: `204-894-9071` (linked)
  - Email: `info@petefixes.ca` (linked)
  - Service Area: Winnipeg, MB & Surrounding Areas
  - Follow Us: @petefixes (linked to Instagram)

### Right Column — Form
- Use **Wix Forms** (built-in)
- White background card with rounded corners (20px) and shadow
- Padding: 40px
- Fields:
  - First Name + Last Name (side by side)
  - Email
  - Phone
  - Service Interested In (dropdown: Automatic Gates, Fencing, Access Control, Security Solutions, Emergency Repair, Other)
  - How Can We Help? (textarea)
  - Send Message button (gold, full-width pill)
- Form submission: connect to Wix Inbox / email notification
- Success message: "We'll respond within 24 hours."

---

## 9. Footer

### Wix Component: **Footer**
- Background: `#F5F5F7`
- Top border: 1px solid `#E8E8ED`

### Layout: 4 columns
1. **Brand:** Logo + tagline "build. secure. fixes." (italic, gray)
2. **Services:** Automatic Gates, Fencing, Access Control, Security Solutions (linked to sections)
3. **Company:** Gallery, Contact Us, Instagram (external link)
4. **Contact:** Phone, Email, "Winnipeg, MB, Canada"

### Bottom Bar
- Centered: "(c) 2026 Pete Fixes. All rights reserved."
- 13px, gray-400

---

## 10. SEO Setup in Wix

### Page Settings (Wix Editor > Page > SEO)
- **Title:** `Pete Fixes | Automatic Gates, Fencing & Security Solutions in Winnipeg`
- **Description:** `Pete Fixes provides expert automatic gate installation, custom fencing, access control systems and security solutions in Winnipeg, MB. Call 204-894-9071 for a free consultation.`
- **URL slug:** `/` (homepage)

### Site-Wide SEO (Wix Dashboard > SEO Tools)
1. **Connect Google Search Console** and submit sitemap
2. **Add structured data** — Go to Wix SEO Settings > Advanced > Custom Code, and paste the JSON-LD from the HTML `<head>` into the head section
3. **Set Open Graph tags** for social sharing (use the meta tag values from the HTML)
4. **Enable SEO-friendly URLs** for all pages

### Additional SEO Recommendations
- Add a **Google Business Profile** and link it
- Create individual service pages (e.g., `/services/automatic-gates`) with unique content
- Add **alt text** to every image describing what's shown
- Install **Wix SEO Wiz** and follow its recommendations
- Add a blog section for content marketing (e.g., "5 Signs You Need an Automatic Gate")
- Ensure mobile performance is optimized (Wix handles this with responsive modes)

---

## 11. Animations & Interactions

### Scroll-Triggered Fade-In
- In Wix, select each section's content elements
- Go to **Animation > Fade In** with ~0.7s duration
- Trigger: "On scroll into view"
- Use staggered delays for "Why Pete Fixes" cards (0s, 0.1s, 0.2s, 0.3s)

### Button Hover Effects
- Scale to 1.02 on hover (set in Wix button design > hover state)
- Color shift for gold buttons: `#C8A55A` -> `#B8953A`

### Gallery Hover
- Slight scale (1.02) on image hover

---

## 12. Mobile Responsive

Wix handles responsive design automatically, but verify:
- **Nav** collapses to hamburger menu on mobile
- **Service blocks** stack to single column
- **Why Pete Fixes** cards stack to single column
- **Gallery** switches to single column
- **Contact** form stacks below info
- **Buttons** go full-width on small screens
- **Footer** stacks to single column

---

## File Reference

- `index.html` — Full page structure and content
- `styles.css` — Complete design system with all colors, spacing, typography

Open `index.html` in your browser to see the live preview of the redesign.
