import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { companyDocuments } from "../../lib/company-content";
import { GateExample } from "../ui/company";
import { ContactForm } from "../ui/contact";
export function generateStaticParams() {
  return Object.keys(companyDocuments).map((key) => ({ slug: key.split("/") }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const d = companyDocuments[slug.join("/")];
  return {
    alternates: { canonical: `/${slug.join("/")}/` },
    title: d ? `${d.title} — PayFlow` : "PayFlow",
    description: d?.intro,
  };
}
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const key = slug.join("/");
  const doc = companyDocuments[key];
  if (!doc) notFound();
  return (
    <article className="company-document">
      <p className="eyebrow">PAYFLOW / {slug[0]}</p>
      <h1>{doc.title}</h1>
      <p className="intro">{doc.intro}</p>
      {key === "sandbox" && <GateExample />}
      {doc.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {section.code && (
            <pre>
              <code>{section.code}</code>
            </pre>
          )}
        </section>
      ))}
      {key === "contact" && <ContactForm />}
      {doc.links && (
        <nav className="doc-links" aria-label="Further reading">
          {doc.links.map(([label, href]) => (
            <Link key={href} href={href}>
              {label} →
            </Link>
          ))}
        </nav>
      )}
    </article>
  );
}
