const _ = require('lodash');
const fs = require('graceful-fs');
const mkdirp = require('mkdirp');
const path = require('path');
const request = require('request');
const sqlite3 = require('better-sqlite3');

const docsetName = 'joi.docset';
const docsetVersion = require('./package').version;
const referenceUrl = `https://raw.githubusercontent.com/hapijs/joi/v${docsetVersion}/API.md`;

const resourcesPath = path.join(__dirname, docsetName, 'Contents', 'Resources');
const documentsPath = path.join(resourcesPath, 'Documents');
const dbFile = path.join(resourcesPath, 'docSet.dsidx');

let db;

function prepareIndexEntry(method, anchor) {
  let type = 'Guide';

  if( /^(?:Hapi|plugin).[a-z]/g.test(method) ) {
    type = 'Property';
  } else if( /^Hapi.[A-Z]/g.test(method) ) {
    type = 'Constructor';
  }

  if( method.indexOf('(') !== -1 ) {
    type = 'Method';
    const idx = method.indexOf('.');
    if( idx !== -1 ) {
      method = 'Joi.' + method.substr(0, idx) + '()' + method.substr(idx);
    } else {
      method = 'Joi.' + method;
    }
  } else if( /^[a-z]*$/g.test(method) ) {
    method = 'Joi.' + method + '()';
    type = 'Constructor';
  }

  if( method.indexOf('new ') === 0 ) {
    type = 'Constructor';
  }

  return { method, anchor, type };
}

function fetchRawMarkdown(url) {
  return new Promise(function(resolve, reject) {
    request(url, function(err, res, payload) {
      const remainingCalls = res && res.headers ? res.headers['x-ratelimit-remaining'] : null;

      if( remainingCalls ) {
        console.log('Remaining github calls: ' + remainingCalls);
      }

      if( payload ) {
        console.log('Raw markdown fetched!');
        return resolve(payload);
      } else {
        return reject(err);
      }
    });
  });
}

function removeHeader(markdown) {
  return new Promise(function(resolve) {
    markdown = '# Joi Reference' + markdown.split('<img src="https://raw.github.com/hapijs/joi/master/images/validation.png" align="right" />')[1];
    resolve(markdown);
  });
}

function createSearchIndex(markdown) {
  return new Promise(function(resolve) {
    const stmt = db.prepare('INSERT OR IGNORE INTO searchIndex(name, type, path) VALUES (?, ?, ?)');

    const guidesRegex = /\n- *\[(?:`|)([^`}\]]*)(?:`|)]\((#[A-Za-z\-]*)\)/g;
    for( let matches; matches = guidesRegex.exec(markdown); ) {
      const entry = prepareIndexEntry(matches[1], matches[2]);
      stmt.run(entry.method, entry.type, 'reference.html' + entry.anchor);
    }

    const methodRegex = /\n[\s]*-[\s]*\[`([A-Za-z.]*.*)`]\((#[A-Za-z\-]*)\)/g;
    for( let matches; matches = methodRegex.exec(markdown); ) {
      const entry = prepareIndexEntry(matches[1], matches[2]);
      stmt.run(entry.method, entry.type, 'reference.html' + entry.anchor);
    }

    console.log('Search index created!');
    resolve(markdown);
  });
}

function generateHtml(markdown) {
  const payload = {
    text: markdown,
    mode: 'markdown',
    context: ''
  };

  return new Promise(function(resolve, reject) {
    request.post({
      url: 'https://api.github.com/markdown',
      headers: {
        'User-Agent': 'hapi docset generator'
      },
      json: payload
    }, function(err, res, payload) {
      const remainingCalls = res && res.headers ? res.headers['x-ratelimit-remaining'] : null;

      if( remainingCalls ) {
        console.log('Remaining github calls: ' + remainingCalls);
      }

      if( payload ) {
        console.log('HTML generated from Markdown');
        return resolve(payload);
      } else {
        return reject(err);
      }
    });
  });
}

function replaceUserContent(text) {
  return new Promise(function(resolve) {
    const replaced = text.replace(/user-content-/g, '');
    console.log('HTML cleanup completed!');
    return resolve(replaced);
  });
}

function addDashAnchors(text) {
  return new Promise(function(resolve) {
    db.prepare('SELECT name, type, path FROM searchIndex').all().forEach(row => {
      const dashAnchor = '<a name="//apple_ref/cpp/' + row.type + '/' + encodeURIComponent(row.name) + '" class="dashAnchor"></a>';
      const searchTerm = '<a name="' + row.path.split('#')[1] + '"';
      text = text.replace(new RegExp(searchTerm, 'g'), dashAnchor + searchTerm);
    });
    return resolve(text);
  });
}

function wrapInDocument(text) {
  return new Promise(function(resolve) {
    const header = fs.readFileSync(path.join(__dirname, 'static', 'header.txt'));
    const footer = fs.readFileSync(path.join(__dirname, 'static', 'footer.txt'));
    console.log('Body wrapped with header and footer!');
    return resolve(header + text + footer);
  });
}

function writeFile(text) {
  return new Promise(function(resolve, reject) {
    fs.writeFile(documentsPath + '/reference.html', text, function(err) {
      if( err ) {
        reject(err);
      } else {
        console.log('reference.html written');
        resolve(text);
      }
    });
  });
}

mkdirp(documentsPath, function(err) {
  fs.unlink(dbFile, function(error) {
    if( !error ) {
      console.log('Previous database deleted!');
    }

    db = new sqlite3(dbFile);
    db.pragma('synchronous = FULL');

    db.exec('CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);');
    db.exec('CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);');

    fetchRawMarkdown(referenceUrl)
    .then(removeHeader)
    .then(createSearchIndex)
    .then(generateHtml)
    .then(replaceUserContent)
    .then(addDashAnchors)
    .then(wrapInDocument)
    .then(writeFile)
    .then(markdown => {
      console.log('Generation completed!');
      db.close();
      db = null;
    })
    .catch(err => {
      console.log(err);
      db.close();
      db = null;
    });

  });
});

