# SEO Standards

## Public Pages

Public marketing, content, event, product, and business pages must render meaningful HTML without requiring client-side JavaScript.

Every public route should define:

- unique title
- meta description
- canonical URL
- Open Graph title, description, and image when shareable
- appropriate heading hierarchy

## SPA Limits

- Do not use client-only SPA rendering for pages that need search indexing.
- If SPA behavior is used on public pages, server-rendered or statically generated HTML must still contain the meaningful content.
- Important pages must have stable URLs.

## Structured Data

Use JSON-LD when applicable:

- LocalBusiness
- Event
- Product
- Article
- FAQPage
- BreadcrumbList

## Required Files

Public sites should provide:

- `robots.txt`
- `sitemap.xml`
- real 404 behavior
- canonical metadata

## Review Requirement

Reviewers should fail SEO-sensitive work if the page is only meaningful after JavaScript runs.

