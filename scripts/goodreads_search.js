// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// ==WebMCP==
// @name        search
// @match       https://www.goodreads.com/*
// @description Search Goodreads for books by title, author or keyword and
// @description return the matches with their author, publication year, average
// @description rating, number of ratings and Goodreads link. Use this to
// @description identify a book, check how well reviewed it is, or find what
// @description else an author has written. Does not need the reader to be
// @description signed in.
// @schema      {"type":"object","properties":{"query":{"type":"string","description":"What to search for: a book title, an author name, or free keywords."},"field":{"type":"string","enum":["all","title","author"],"description":"Restrict the search to titles only or authors only. Defaults to all, which is what the site's own search box does."},"page":{"type":"integer","description":"Results page to read, 20 results per page. Defaults to 1."},"max_results":{"type":"integer","description":"How many of the page's 20 results to return. Defaults to 20."}},"required":["query"]}
// ==/WebMCP==

// Goodreads retired its public API in December 2020 and issues no new keys, so
// the only way to search it is the same /search page a reader uses. It is
// server-rendered, same-origin from here, and needs no session, so one fetch
// gets the whole result set with no key and no rate limit to budget for.
//
// Two other routes were rejected. /search?format=json answers 406, so there is
// no JSON version of this page to prefer. /book/auto_complete?format=json does
// return clean JSON, but it is the search-box typeahead and caps at five
// results with no publication year or edition count, which is too thin for a
// tool whose job is to survey what exists.
//
// The rows are read through their schema.org microdata rather than Goodreads'
// CSS classes wherever the markup offers it, since itemtype/itemprop are the
// most stable thing on the page. The per-row rating, year and edition count are
// only available as one run of prose ("4.29 avg rating - 1,693,619 ratings -
// published 1965 - 62 editions"), so those are pulled out by pattern and each
// is reported only when its pattern matched.

const args = input || {};
const query = String(args.query === undefined ? '' : args.query).trim();
if (!query) {
  return 'No search query was given, so there is nothing to look up on ' +
    'Goodreads.';
}

// Goodreads fixes the results page at 20 rows, so that is also the ceiling on
// what one call can return; more than that is a page= away.
const PER_PAGE = 20;
const page = Math.min(Math.max(parseInt(args.page, 10) || 1, 1), 100);
const maxResults = Math.min(
  Math.max(parseInt(args.max_results, 10) || PER_PAGE, 1), PER_PAGE);
const field = ['title', 'author'].indexOf(String(args.field || 'all')) === -1 ?
  'all' : String(args.field);

const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const textOf = (node, selector) => {
  const found = node.querySelector(selector);
  return found ? collapse(found.textContent) : '';
};

// A book can list several contributors. Each sits in its own container, and a
// contributor who did not write the book has a role in a sibling span that
// confusingly carries the authorName class too, so take names from the anchors
// and roles separately: "(Introduction)" or "(Illustrator)" changes what the
// entry means and is worth keeping.
const authorsOf = (row) => {
  const out = [];
  const containers = row.querySelectorAll('div.authorName__container');
  const scopes = containers.length ? containers :
    row.querySelectorAll('a.authorName');
  scopes.forEach((scope) => {
    const anchor = scope.tagName === 'A' ? scope :
      scope.querySelector('a.authorName');
    const name = anchor ? collapse(anchor.textContent) : '';
    if (!name) {
      return;
    }
    const role = textOf(scope, 'span.role');
    const entry = role ? name + ' ' + role : name;
    if (out.indexOf(entry) === -1) {
      out.push(entry);
    }
  });
  return out;
};

// Result hrefs carry the search's own tracking parameters
// (?from_search=true&qid=...&rank=1). Drop them so the link is the stable,
// shareable book URL.
const bookUrl = (node) => {
  const link = node.querySelector('a.bookTitle');
  const href = link && link.getAttribute('href');
  if (!href) {
    return '';
  }
  return 'https://www.goodreads.com' + href.split('?')[0];
};

try {
  let url = '/search?q=' + encodeURIComponent(query) + '&page=' + page;
  if (field !== 'all') {
    // Rails nests this as search[field]; the brackets have to stay encoded.
    url += '&search%5Bfield%5D=' + field;
  }

  const response = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!response.ok) {
    return 'Goodreads answered HTTP ' + response.status + ' for a search for ' +
      '"' + query + '".';
  }

  // Parse in an inert document so nothing in the returned page is executed or
  // fetched.
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const rows = doc.querySelectorAll('tr[itemtype*="schema.org/Book"]');
  if (!rows.length) {
    // A search that matched nothing and a search page whose markup has changed
    // both arrive here, and they need different answers. Goodreads puts the
    // match count in the page title, so a title reporting 0 books is a genuine
    // empty result rather than a parsing failure.
    if (/of\s+0\s+books/.test(doc.title || '')) {
      return 'Goodreads found no books matching "' + query + '"' +
        (field === 'all' ? '' : ' searching ' + field + 's only') + '.';
    }
    return 'Could not find any results in Goodreads\' search page for "' +
      query + '". The tool reads the rendered search page, so this most ' +
      'likely means its markup has changed and the tool needs updating.';
  }

  // "Search results for "dune" (showing 1-20 of 105235 books)".
  const totalMatch = (doc.title || '').match(/of\s+([\d,]+)\s+books/);

  const books = [];
  rows.forEach((row) => {
    if (books.length >= maxResults) {
      return;
    }
    const title = textOf(row, 'a.bookTitle');
    if (!title) {
      return;
    }
    // A book can list several contributors, each tagged as an author even when
    // the container notes a role such as (Illustrator).
    const authors = authorsOf(row);
    const meta = textOf(row, 'span.greyText.smallText.uitext') ||
      textOf(row, 'span.minirating');
    books.push({
      title: title,
      authors: authors,
      url: bookUrl(row),
      avg: meta.match(/([\d.]+)\s+avg rating/),
      ratings: meta.match(/([\d,]+)\s+ratings?/),
      year: meta.match(/published\s+(\d{4})/),
      editions: meta.match(/([\d,]+)\s+editions?/),
    });
  });

  if (!books.length) {
    return 'Goodreads\' search page held ' + rows.length + ' result rows for ' +
      '"' + query + '" but none of them had a readable title, which means ' +
      'the page markup has changed and the tool needs updating.';
  }

  const lines = [];
  const first = (page - 1) * PER_PAGE + 1;
  lines.push('Goodreads results ' + first + '-' + (first + books.length - 1) +
    (totalMatch ? ' of ' + totalMatch[1] : '') + ' for "' + query + '"' +
    (field === 'all' ? '' : ', searching ' + field + 's only') +
    ', most relevant first. Ratings are the Goodreads community average out ' +
    'of 5.');
  lines.push('');

  books.forEach((book) => {
    lines.push('- ' + book.title);
    const facts = [];
    facts.push(book.authors.length ? book.authors.join(', ') :
      'author not listed');
    if (book.year) {
      facts.push('published ' + book.year[1]);
    }
    if (book.avg) {
      facts.push(book.avg[1] + ' avg' +
        (book.ratings ? ' from ' + book.ratings[1] + ' ratings' : ''));
    }
    if (book.editions) {
      facts.push(book.editions[1] + ' editions');
    }
    lines.push('  ' + facts.join('  |  '));
    if (book.url) {
      lines.push('  ' + book.url);
    }
  });

  if (totalMatch) {
    const total = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    if (total > first + books.length - 1) {
      lines.push('');
      lines.push('Goodreads reports ' + totalMatch[1] + ' matches in total. ' +
        'Ask for page ' + (page + 1) + ' to see the next ' + PER_PAGE + ', ' +
        'or narrow the query, since relevance drops off quickly after the ' +
        'first page.');
    }
  }

  return lines.join('\n');
} catch (error) {
  return 'Could not search Goodreads for "' + query + '": ' +
    (error && error.message ? error.message : String(error));
}
