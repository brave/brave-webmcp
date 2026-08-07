// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// ==WebMCP==
// @name        my_books
// @match       https://www.goodreads.com/*
// @description List the books on one of the signed-in reader's own Goodreads
// @description shelves, with their rating, review, page count and the dates
// @description they were added and read. Use this to answer questions about
// @description what the reader is reading now, has already read, or means to
// @description read next. Requires being signed in to goodreads.com, and says
// @description so plainly when nobody is.
// @schema      {"type":"object","properties":{"shelf":{"type":"string","description":"Which shelf to read: one of the built-in read, currently-reading or to-read, or the name of a custom shelf. Use all for every book regardless of shelf. Defaults to currently-reading."},"max_books":{"type":"integer","description":"How many books to return, newest first, up to 200. Defaults to 25."},"sort":{"type":"string","enum":["date_added","date_read","rating","title","author"],"description":"Order the shelf by this field, highest or newest first. Defaults to date_added."},"include_reviews":{"type":"boolean","description":"Include the reader's own review text for each book. Defaults to false."}}}
// ==/WebMCP==

// Goodreads retired its public API in December 2020 and issues no new keys, so
// a reader's own shelves have to come from the site itself. Two same-origin
// requests do it, and both send the session cookie, which is the only reason
// private shelves and unpublished reviews are visible at all.
//
// 1. /review/list, to find out who is signed in. Signed out it redirects to
//    /user/sign_in, so the final URL is a reliable signed-in test that needs no
//    guessing about page markup. Signed in it is the reader's own My Books
//    page, which supplies both their numeric id and the list of shelf names
//    that step 2 needs.
//
// 2. /review/list_rss/<id>, the shelf feed. This is preferred over scraping the
//    My Books table even though the table is already in hand, because the feed
//    is a stable document with one named element per fact -- user_rating,
//    user_read_at, average_rating, num_pages -- rather than CSS classes that
//    change with a redesign, and because per_page keeps the response
//    proportional to what was asked for instead of pulling the whole shelf.
//
// Three quirks of that feed are worth knowing, all of them checked against a
// live public shelf, because each one fails silently rather than loudly:
//
//   - An unrecognised shelf name is not an error. The feed quietly returns
//     every book the reader owns, which would look like a perfectly good answer
//     to the wrong question. So the shelf name is checked against the shelves
//     found in step 1 before asking, and an unknown one is refused.
//   - An unrecognised sort value likewise reorders the shelf by something else
//     instead of failing, so only known values are ever passed through.
//   - The order parameter is ignored outright: order=a and order=d return
//     identical feeds. Every sort is therefore highest or newest first, and no
//     ascending option is offered rather than offering one that does nothing.

const args = input || {};

// per_page is honoured up to 200; asking for more silently drops back to 100.
const MAX_BOOKS = 200;
const MAX_REVIEW_CHARS = 400;
const SORTS = ['date_added', 'date_read', 'rating', 'title', 'author'];

const maxBooks = Math.min(
  Math.max(parseInt(args.max_books, 10) || 25, 1), MAX_BOOKS);
const includeReviews = args.include_reviews === true;
const sort = SORTS.indexOf(String(args.sort || '')) === -1 ?
  '' : String(args.sort);

const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// Shelf names are slugs on Goodreads, so "Currently Reading" and
// "currently reading" both have to become currently-reading. The aliases are
// the phrases a reader is likely to say for the three built-in shelves.
const ALIASES = {
  reading: 'currently-reading',
  current: 'currently-reading',
  'want-to-read': 'to-read',
  'to-be-read': 'to-read',
  tbr: 'to-read',
  finished: 'read',
  'have-read': 'read',
  everything: 'all',
};
const rawShelf = collapse(args.shelf === undefined ? '' : args.shelf)
  .toLowerCase().replace(/\s+/g, '-');
// hasOwnProperty, so that a shelf genuinely called "constructor" or "toString"
// resolves to itself rather than to something off Object.prototype.
const shelf = Object.prototype.hasOwnProperty.call(ALIASES, rawShelf) ?
  ALIASES[rawShelf] : (rawShelf || 'currently-reading');

const decodeSlug = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (error) {
    return String(value);
  }
};

// Parse HTML in an inert document so nothing in it is executed or fetched.
const parseHtml = (html) =>
  new DOMParser().parseFromString(String(html || ''), 'text/html');

const toText = (html) => {
  if (!html) {
    return '';
  }
  const body = parseHtml(html).body;
  return body ? collapse(body.textContent) : '';
};

const idFrom = (value) => {
  const found = String(value || '').match(/\/review\/list\/(\d+)/);
  return found ? found[1] : '';
};

// Every shelf link on the My Books page carries the shelf name in its query
// string, which is a far more stable place to read the shelf list from than
// whatever markup currently wraps the sidebar. Goodreads' pseudo-shelf for
// everything is #ALL#, which is not a name a reader can ask for.
const shelvesFrom = (doc) => {
  const found = [];
  doc.querySelectorAll('a[href*="shelf="]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (href.indexOf('/review/list') === -1) {
      return;
    }
    const match = href.match(/[?&]shelf=([^&#"]+)/);
    if (!match) {
      return;
    }
    const name = decodeSlug(match[1]).toLowerCase();
    if (name && name.charAt(0) !== '#' && found.indexOf(name) === -1) {
      found.push(name);
    }
  });
  return found;
};

const field = (item, name) => {
  const nodes = item.getElementsByTagName(name);
  return nodes.length ? collapse(nodes[0].textContent) : '';
};

// Feed dates carry the shelf owner's own offset, e.g.
// Sat, 01 Aug 2026 15:59:01 -0700. Reduce to a UTC calendar day so dates from
// different sources can be compared, and say so in the output.
const day = (value) => {
  const parsed = new Date(String(value || ''));
  if (isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString().slice(0, 10);
};

try {
  const listResponse = await fetch('/review/list', {
    // Same-origin, so the session cookie rides along: this is what makes the
    // reader's own shelves, including private ones, visible.
    credentials: 'same-origin',
    headers: { Accept: 'text/html' },
  });

  const landedOn = listResponse.url || '';
  if (landedOn.indexOf('/user/sign_in') !== -1 ||
      landedOn.indexOf('/user/new') !== -1) {
    return 'Nobody is signed in to goodreads.com in this browser, so there ' +
      'are no shelves to read. Signing in at goodreads.com and asking again ' +
      'will work.';
  }
  if (!listResponse.ok) {
    return 'Goodreads answered HTTP ' + listResponse.status + ' for the My ' +
      'Books page, so the signed-in reader\'s shelves could not be read.';
  }

  const listDoc = parseHtml(await listResponse.text());
  const userId = idFrom(landedOn) || idFrom(listDoc.body.innerHTML);
  if (!userId) {
    return 'Could not work out which Goodreads account is signed in: the My ' +
      'Books page did not contain the reader\'s numeric user id where the ' +
      'tool expects it, which means its markup has changed and the tool ' +
      'needs updating.';
  }

  // An unknown shelf name would otherwise return the reader's whole library as
  // if it were the shelf they asked for, so refuse it while the real shelf
  // names are still to hand. If none were found the check is skipped rather
  // than blocking the request, and the caveat is reported with the results.
  const known = shelvesFrom(listDoc);
  if (shelf !== 'all' && known.length && known.indexOf(shelf) === -1) {
    return 'There is no shelf called "' + shelf + '" on this Goodreads ' +
      'account. The shelves it does have are: ' + known.join(', ') + '. Use ' +
      'all to read every book regardless of shelf.';
  }

  let feedUrl = '/review/list_rss/' + userId + '?per_page=' + maxBooks;
  if (shelf !== 'all') {
    feedUrl += '&shelf=' + encodeURIComponent(shelf);
  }
  if (sort) {
    feedUrl += '&sort=' + sort;
  }

  const feedResponse = await fetch(feedUrl, {
    credentials: 'same-origin',
    headers: { Accept: 'application/xml' },
  });
  if (!feedResponse.ok) {
    return 'Goodreads answered HTTP ' + feedResponse.status + ' for the ' +
      '"' + shelf + '" shelf feed.';
  }

  const feed = new DOMParser()
    .parseFromString(await feedResponse.text(), 'text/xml');
  if (feed.getElementsByTagName('parsererror').length) {
    return 'Goodreads returned something that is not valid XML for the ' +
      '"' + shelf + '" shelf, which means the shelf feed has changed shape ' +
      'and the tool needs updating.';
  }

  const items = feed.getElementsByTagName('item');
  if (!items.length) {
    if (shelf === 'all') {
      return 'There are no books at all on the signed-in Goodreads account.';
    }
    return 'The "' + shelf + '" shelf came back empty. Either nothing is on ' +
      'it yet, or the shelf is one the shelf feed will not serve even to the ' +
      'account that owns it.';
  }

  const ordering = sort === 'title' || sort === 'author' ?
    'in reverse ' + sort + ' order' :
    (sort === 'rating' ? 'highest rated first' :
      (sort === 'date_read' ? 'most recently read first' :
        'most recently added first'));

  const lines = [];
  lines.push(items.length + ' book' + (items.length === 1 ? '' : 's') +
    (shelf === 'all' ? ' on the signed-in reader\'s Goodreads account' :
      ' on the signed-in reader\'s "' + shelf + '" Goodreads shelf') +
    ', ' + ordering + '. "my rating" is the reader\'s own score out of 5 and ' +
    '"community" is the Goodreads average. Dates are UTC calendar days.');
  lines.push('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const bookId = field(item, 'book_id');
    const rating = parseInt(field(item, 'user_rating'), 10) || 0;
    const pages = field(item, 'num_pages');
    const published = field(item, 'book_published');
    const average = field(item, 'average_rating');
    const added = day(field(item, 'user_date_added'));
    const read = day(field(item, 'user_read_at'));
    // On an exclusive shelf such as read, user_shelves holds the additional
    // shelves the book also sits on, and is empty when there are none. The
    // shelf that was asked for is dropped, since repeating it against every
    // single book says nothing.
    const also = field(item, 'user_shelves').split(',')
      .map((name) => collapse(name))
      .filter((name) => name && name !== shelf)
      .join(', ');

    lines.push('- ' + (field(item, 'title') || '(untitled)'));

    const facts = [];
    facts.push(field(item, 'author_name') || 'author not listed');
    if (published) {
      facts.push('published ' + published);
    }
    if (pages) {
      facts.push(pages + ' pages');
    }
    facts.push(rating ? 'my rating ' + rating + '/5' : 'not rated by me');
    if (average) {
      facts.push('community ' + average);
    }
    lines.push('  ' + facts.join('  |  '));

    const when = [];
    if (added) {
      when.push('added ' + added);
    }
    if (read) {
      when.push('read ' + read);
    }
    if (also) {
      when.push('also shelved: ' + also);
    }
    if (when.length) {
      lines.push('  ' + when.join('  |  '));
    }

    if (bookId) {
      lines.push('  https://www.goodreads.com/book/show/' + bookId);
    }

    if (includeReviews) {
      // Reviews are authored as HTML, so flatten them the same inert way.
      const review = toText(field(item, 'user_review'));
      if (review) {
        lines.push('  review: ' + (review.length > MAX_REVIEW_CHARS ?
          review.slice(0, MAX_REVIEW_CHARS) + '...' : review));
      }
    }
  }

  const notes = [];
  if (items.length === maxBooks) {
    notes.push('This is the first ' + maxBooks + ' book' +
      (maxBooks === 1 ? '' : 's') + ' only; the shelf may hold more. Ask for ' +
      'a larger max_books to see further down it.');
  }
  if (shelf !== 'all' && !known.length) {
    notes.push('The list of shelves on this account could not be read, so ' +
      '"' + shelf + '" was sent to Goodreads unchecked. Goodreads answers an ' +
      'unknown shelf name with every book on the account rather than an ' +
      'error, so treat the list above with suspicion if it looks broader ' +
      'than the shelf asked for.');
  } else if (known.length > 1) {
    notes.push('Other shelves on this account: ' +
      known.filter((name) => name !== shelf).join(', ') + '.');
  }
  if (notes.length) {
    lines.push('');
    notes.forEach((note) => lines.push('Note: ' + note));
  }

  return lines.join('\n');
} catch (error) {
  return 'Could not read the "' + shelf + '" shelf from Goodreads: ' +
    (error && error.message ? error.message : String(error));
}
