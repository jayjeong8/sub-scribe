import { SubScribe } from "./_components/sub-scribe";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Sub Scribe",
  description:
    "Learn any language by typing or speaking along with YouTube subtitles. Paste a video link, pick a caption track, and practice typing, speaking, or fill-in-the-blank. Free, no signup.",
  url: "/",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

export default function SubScribePage() {
  return (
    <>
      <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      <SubScribe />
    </>
  );
}
