const express = require('express');
const app = express();
const port = 8888;

// Get my secret shit out of .env
require('dotenv').config();

// Using axios for my HTTP requests
const axios = require('axios');

// Requires from Spotify example code
const cors = require('cors');
const querystring = require('querystring');

// Requires for reading and parsing the Google playlist CSVs
const fs = require('fs');
const fsPromises = fs.promises;
const csv = require('csv-parser');
const parse = require('csv-parse/lib/sync');

const { performance } = require('perf_hooks');

// For uploading and unzipping the Google zip file
const formidable = require('formidable');
const StreamZip = require('node-stream-zip');

const stateKey = 'spotify_auth_state';

// Middleware from Spotify example code (use cors and cookieParser, don't use static)
// app.use(express.static(__dirname + '/public')).use(cors()).use(cookieParser());
//
// According to the express-session docs, cookie-parser is no longer needed and
// may even result in issues if the secret isn't the same between the two middlewares.
// app.use(cors()).use(cookieParser());
app.use(cors());

// Middleware to keep track of each user session, handles cookies for me as well
const session = require('express-session');
const { compile } = require('ejs');
app.use(
  session({
    secret: 'I have a twelve inch cock. His name is Stewey!',
    resave: false,
    saveUninitialized: false
  })
);

// Set the public directory as static
app.use(express.static(__dirname + '/public'));

// To parse the body data
const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true }));

// Set the view engine to ejs
app.set('view engine', 'ejs');

// Global variables from Spotify example code
// Replace the client_secret before productizing
const client_id = process.env.SPOTIFY_CLIENT_ID; // Your client id
const client_secret = process.env.SPOTIFY_CLIENT_SECRET; // Your secret
const redirect_uri = process.env.SPOTIFY_REDIRECT_URI; // Your redirect uri

// Helper function from Spotify example code
/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
const generateRandomString = function (length) {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

// My middlewares
// All routes other than /login and /callback need Spotify tokens
const hasSpotifyTokens = (req, res, next) => {
  // Check for Spotify access tokens
  if (req.session.tokens) {
    // Check to see when the tokens expire (convert milliseconds to minutes)
    const timeLeft = Math.trunc(
      (req.session.tokens.expiration - Date.now()) / 1000 / 60
    );

    // If less than some acceptable value, redirect to /refresh_token
    // (being a bit conservative with refreshing when the token has less than 5 minutes left)
    if (timeLeft < 5) {
      res.redirect(`/refresh_token?redirect=${req.originalUrl}`);
      return;
    }
    return next();
  }
  // Redirect to /login
  res.redirect('/login');
};
app.use(
  [ '/playlist', '/zipuploader', '/user', '/refreshtoken' ],
  hasSpotifyTokens
);

// All /playlist routes need the Google playlists
const hasGooglePlaylists = (req, res, next) => {
  // Check for Google Playlists object
  if (req.session.googlePlaylists) {
    return next();
  }
  // Redirect to /zipuploader
  res.redirect('/zipuploader');
};
app.use('/playlist', hasGooglePlaylists);

/////////////////////////////////////////////
// Routes
/////////////////////////////////////////////

// Root
app.get('/', (req, res) => {
  // Probably bad design, but since I don't have a landing page yet, immediately redirect to /playlist
  res.redirect('/playlist');
});

/////////////////////////////////////////////
// Playlist Routes
/////////////////////////////////////////////

// View the library (all playlists) - "/playlist"
app.get('/playlist', async (req, res) => {
  // Get the user's Spotify playlists
  let spotifyPlaylists = [];

  // Make playlist requests until there are no more playlists to request
  // By default, the Spotify playlists endpoint will return 20 playlists
  // The next field in the return data contains the URL for the next batch to request
  let playlistsUrl = 'https://api.spotify.com/v1/me/playlists';
  while (playlistsUrl) {
    const playlistsData = await getSpotifyData(
      playlistsUrl,
      req.session.tokens
    );
    spotifyPlaylists = spotifyPlaylists.concat(playlistsData.items);
    playlistsUrl = playlistsData.next;
  }

  // Map the Spotify playlists onto the Google playlists
  req.session.googlePlaylists = req.session.googlePlaylists.map(
    (googlePlaylist) => {
      let updatedSpotifyPlaylist = undefined;

      // If there is already a spotifyPlaylist associated with this googlePlaylist
      if (googlePlaylist.spotifyPlaylist) {
        // Find the matching playlist based on Spotify playlist ID
        updatedSpotifyPlaylist = spotifyPlaylists.find(
          (spotifyPlaylist) =>
            googlePlaylist.spotifyPlaylist.id === spotifyPlaylist.id
        );
      }

      // If the updated Spotify playlist is still undefined
      if (!updatedSpotifyPlaylist) {
        // Find the matching playlist based on the playlist name
        updatedSpotifyPlaylist = spotifyPlaylists.find(
          (spotifyPlaylist) => googlePlaylist.name === spotifyPlaylist.name
        );
      }

      // Update the spotifyPlaylist and return
      googlePlaylist.spotifyPlaylist = updatedSpotifyPlaylist;
      return googlePlaylist;
    }
  );

  // Render the library template
  res.render('library', {
    user: req.session.user,
    googlePlaylists: req.session.googlePlaylists
  });
});

// View a playlist (single playlist) - "/playlist/:playlistId"
app.get('/playlist/:playlistId', async (req, res) => {
  const playlistId = req.params.playlistId;
  let currentPage = req.query.page;
  let queryTrack = req.query.track;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[playlistId]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Get the Google playlist
  const googlePlaylist = req.session.googlePlaylists[playlistId];

  // Paginate the playlist tracks (25 tracks per page, for now)
  const tracksPerPage = 25;
  const totalPages = Math.ceil(
    googlePlaylist.googleTracks.length / tracksPerPage
  );
  const lastPage = totalPages - 1;
  // Do some input validation of the provided page
  // First attempt to turn the query string into an integer
  currentPage = parseInt(currentPage);
  // If NaN, default to page 0
  if (isNaN(currentPage)) {
    currentPage = 0;
  } else {
    // The page in the query string is 1 based
    // change to 0 based page numbers for the rest of the function
    currentPage = currentPage - 1;

    // If page number is negative, default to page 0
    currentPage = currentPage < 0 ? 0 : currentPage;
    // If greater than the last page, default to the last page
    currentPage = currentPage > lastPage ? lastPage : currentPage;
  }

  // If a particular track is queried, redirect to that that page/track
  // Assumes that if both track and page are queried, track wins
  // Validate the track input
  queryTrack = parseInt(queryTrack);
  if (
    !isNaN(queryTrack) &&
    queryTrack >= 0 &&
    queryTrack < googlePlaylist.googleTracks.length
  ) {
    // Calculate which page and sliceTrackId this track is for the redirection
    // Remember pages are 1 based on the query string
    const trackPage = Math.trunc(queryTrack / tracksPerPage) + 1;
    const sliceTrackId = queryTrack % tracksPerPage;
    res.redirect(
      `/playlist/${playlistId}?page=${trackPage}#result-${sliceTrackId}`
    );
    return;
  }

  // Get the track range to slice
  const startPageTrack = currentPage * tracksPerPage;
  const endPageTrack = startPageTrack + tracksPerPage;
  const pageTracks = googlePlaylist.googleTracks.slice(
    startPageTrack,
    endPageTrack
  );

  // Filter out the tracks that already have a spotifyTrack
  // No need to search for them again
  let searchTracks = pageTracks.filter((track) => !track.spotifyTrack);

  searchTracks = await Promise.all(
    searchTracks.map(async (track) => {
      const searchResults = await spotifySearch(
        {
          track: track.name,
          artist: track.artist,
          album: track.album
        },
        req.session.tokens
      );

      // Check the results
      if (searchResults.length === 0) {
        // If no results, set spotifyTrack to false (so it is definitely falsey)
        track.spotifyTrack = false;
      } else if (searchResults.length === 1) {
        // If only one is returned, the choice is obvious
        track.spotifyTrack = searchResults[0];
      } else {
        // Find the best fit
        const bestFit = searchResults.find(
          (spotifyTrack) =>
            spotifyTrack.name === track.name &&
            spotifyTrack.artists.includes(track.artist) &&
            spotifyTrack.album.name === track.album
        );

        if (bestFit) {
          // If found, update spotifyTrack
          track.spotifyTrack = bestFit;
        } else {
          // Otherwise punt and take the first one in the list
          track.spotifyTrack = searchResults[0];
        }
      }
    })
  );

  // Render this playlist
  res.render('playlist', {
    user: req.session.user,
    googlePlaylist: googlePlaylist,
    playlistId: playlistId,
    currentPage: currentPage + 1, // Go back to 1 based page numbers
    totalPages: totalPages,
    startPageTrackId: startPageTrack,
    pageTracks: pageTracks
  });
});

// Add a playlist - "/playlist/add"
app.post('/playlist/add', async (req, res) => {
  // Get the particulars for the new Spotify playlist out of the request body
  const newPlaylist = req.body.playlist;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[newPlaylist.id]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Create the playlist
  const userId = req.session.user.id;
  const createdPlaylist = await postSpotifyData(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    req.session.tokens,
    {
      name: newPlaylist.name,
      description: newPlaylist.description
    }
  );
  req.session.googlePlaylists[newPlaylist.id].spotifyPlaylist = createdPlaylist;

  res.redirect(`/playlist/${newPlaylist.id}`);
});

// Delete a playlist - "/playlist/:playlistId/delete"
app.post('/playlist/:playlistId/delete', async (req, res) => {
  const playlistId = req.params.playlistId;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[playlistId]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Remove the Google playlist from the library
  req.session.googlePlaylists.splice(playlistId, 1);

  // Redirect to the root route
  res.redirect(`/#playlist-${playlistId}`);
});

// Upload a playlist to Spotify - "/playlist/:playlistId/upload"
app.post('/playlist/:playlistId/upload', async (req, res) => {
  const playlistId = req.params.playlistId;

  // Check that this playlist exists and has an associated Spotify playlist
  if (
    !req.session.googlePlaylists[playlistId] ||
    !req.session.googlePlaylists[playlistId].spotifyPlaylist
  ) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Get the Spotify playlist ID to be updated and track URIs to add
  const spotifyPlaylistId =
    req.session.googlePlaylists[playlistId].spotifyPlaylist.id;
  const spotifyTrackUris = req.session.googlePlaylists[playlistId].googleTracks
    // Map each google track to its Spotify URI
    .map((track) => {
      if (track.spotifyTrack) {
        return track.spotifyTrack.uri;
      }
      return null;
    })
    // Filter out any null tracks
    .filter((track) => track !== null);

  // The Spotify endpoint is limited to 100 tracks added at a time
  // Upload the first 100 tracks, replacing the existing Spotify playlist tracks
  // NOTE: This uses a PUT request, compared to the later POST requests to append the playlist
  let trackSlice = spotifyTrackUris.slice(0, 100);
  await putSpotifyData(
    `https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/tracks`,
    req.session.tokens,
    { uris: trackSlice }
  );
  // Now loop across the remaining tracks (100 at a time), appending the slice to the existing playlist
  for (
    let startIndex = 100;
    startIndex < spotifyTrackUris.length;
    startIndex += 100
  ) {
    trackSlice = spotifyTrackUris.slice(startIndex, startIndex + 100);
    await postSpotifyData(
      `https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/tracks`,
      req.session.tokens,
      { uris: trackSlice }
    );
  }

  res.redirect('/playlist');
});

// View a track - "/playlist/:playlistId/track/:trackId"
app.get('/playlist/:playlistId/track/:trackId', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[playlistId]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Check that this track exists
  if (!req.session.googlePlaylists[playlistId].googleTracks[trackId]) {
    // If not, redirect back to the playlist route
    res.redirect(`/playlist/${playlistId}`);
    return;
  }

  // Get the Google track
  const googleTrack =
    req.session.googlePlaylists[playlistId].googleTracks[trackId];

  // Create a search based on terms provided in the query
  // If no query or empty query, default to a search based on the Google track info
  const searchTerms =
    req.query.search &&
    (req.query.search.track ||
      req.query.search.artist ||
      req.query.search.album)
      ? req.query.search
      : {
          track: googleTrack.name,
          artist: googleTrack.artist,
          album: googleTrack.album
        };

  const searchResults = await spotifySearch(searchTerms, req.session.tokens);

  // Render track.ejs
  res.render('track', {
    user: req.session.user,
    googleTrack: req.session.googlePlaylists[playlistId].googleTracks[trackId],
    playlistId: playlistId,
    trackId: trackId,
    searchTerms: searchTerms,
    searchResults: searchResults
  });
});

// Delete a track - "/playlist/:playlistId/track/:trackId/delete"
app.post('/playlist/:playlistId/track/:trackId/delete', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[playlistId]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Check that this track exists
  if (!req.session.googlePlaylists[playlistId].googleTracks[trackId]) {
    // If not, redirect back to the playlist route
    res.redirect(`/playlist/${playlistId}`);
    return;
  }

  // Remove the Google track from the playlist
  req.session.googlePlaylists[playlistId].googleTracks.splice(trackId, 1);

  // Redirect to the playlist route
  res.redirect(`/playlist/${playlistId}?track=${trackId}`);
});

// Update a track - "/playlist/:playlistId/track/:trackId/update"
app.post('/playlist/:playlistId/track/:trackId/update', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;
  const spotifyTrackId = req.body.spotifyTrackId;

  // Check that this playlist exists
  if (!req.session.googlePlaylists[playlistId]) {
    // If not, redirect back to the library
    res.redirect('/playlist');
    return;
  }

  // Check that this track exists
  if (!req.session.googlePlaylists[playlistId].googleTracks[trackId]) {
    // If not, redirect back to the playlist route
    res.redirect(`/playlist/${playlistId}`);
    return;
  }

  // Get the Spotify track
  const spotifyTrack = await getSpotifyData(
    `https://api.spotify.com/v1/tracks/${spotifyTrackId}`,
    req.session.tokens
  );

  // Update the Spotify track in the Google track
  req.session.googlePlaylists[playlistId].googleTracks[
    trackId
  ].spotifyTrack = spotifyTrack;

  // Redirect to the playlist route
  res.redirect(`/playlist/${playlistId}?track=${trackId}`);
});

/////////////////////////////////////////////
// Google Zip File Uploader Routes
/////////////////////////////////////////////

// Trying to upload a zip file containing the Google playlists CSVs
app.get('/zipuploader', (req, res) => {
  res.render('zipuploader', {
    user: req.session.user,
    errorMsg: undefined
  });
});
app.post('/zipuploader', (req, res) => {
  // Unzip and parse the uploaded file
  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    // First make sure a file with the expected name ('takeout-*.zip') of the expected type was uploaded
    errorMsg = undefined;
    if (!files.filetoupload || !files.filetoupload.name) {
      errorMsg =
        'Missing file, please choose a Google Takeout zip file to upload';
    } else if (
      !files.filetoupload.name.startsWith('takeout') ||
      !files.filetoupload.name.endsWith('.zip')
    ) {
      errorMsg =
        'Bad filename, please choose a Google Takeout zip file ("takeout-*.zip") to upload';
    }
    // FIXME: Checking the MIME type of the file seems like a good idea, but doesn't work in practice. Fix this?
    // else if (files.filetoupload.type !== 'application/x-zip-compressed') {
    //   errorMsg =
    //     'Bad filetype, please choose a Google Takeout zip file to upload';
    // }
    if (errorMsg) {
      // If not, render zipuploader again with an error message
      res.render('zipuploader', {
        user: req.session.user,
        errorMsg: errorMsg
      });
      return;
    }

    // Unzip the uploaded file directly from the tmp directory
    const zip = new StreamZip({
      file: files.filetoupload.path,
      storeEntries: true
    });
    zip.on('error', (err) => {
      console.error(err);
      res.render('error', {
        user: req.session.user,
        error: err
      });
      return;
    });
    zip.on('ready', () => {
      // Array of all CSV files in the zip archive
      const csvFiles = Object.values(zip.entries())
        // Filter out the __MACOSX directory (thank you zip archives created on Mac OS X)
        .filter((entry) => !entry.name.startsWith('__MACOSX'))
        // Return only *.csv files
        .filter((entry) => entry.name.endsWith('.csv'));

      // Get the root of the "Google Play Music" archive, use the first entry in the array
      const googlePlayMusicDir = csvFiles[0].name.replace(
        /^(.*\/Google Play Music).*$/,
        '$1'
      );

      // Parse the playlist CSVs
      let googlePlaylists = csvFiles
        // // Filter out the __MACOSX directory that got created by Fara's computer
        // .filter((entry) => !entry.name.startsWith('__MACOSX'))
        // Playlist CSVs are all the same filename (different directories, of course)
        .filter((entry) => entry.name.endsWith('Metadata.csv'))
        // Unzip the CSV file to a string
        .map((csv) => {
          return {
            data: zip.entryDataSync(csv).toString('utf8'),
            directory: csv.name.replace(/Metadata.csv$/, 'Tracks')
          };
        })
        // Parse the CSV string
        .map((csv) => {
          // NOTE: parse returns an array of objects, there should only be one
          csv.parsed = parse(csv.data, {
            columns: true,
            skip_empty_lines: true
          })[0];
          return csv;
        })
        // Filter out the deleted playlists
        .filter((csv) => csv.parsed.Deleted !== 'Yes');

      // There are two directories with tracks that don't follow the above paradigm, add them manually here
      googlePlaylists.push(
        {
          directory: `${googlePlayMusicDir}/Playlists/Thumbs Up`,
          parsed: {
            Title: 'Google Music - Thumbs Up',
            Description: 'Tracks which were given a Thumbs Up in Google Music'
          }
        },
        {
          directory: `${googlePlayMusicDir}/Tracks`,
          parsed: {
            Title: 'Google Music - Tracks',
            Description: 'Tracks from the Google Music library'
          }
        }
      );

      // Parse the track CSVs for each playlist
      googlePlaylists = googlePlaylists
        .map((playlist) => {
          // Parse the playlist CSVs for this playlist
          let googleTracks = csvFiles
            // Track CSVs all have different names, but live in the playlist directory
            .filter((entry) => entry.name.startsWith(playlist.directory))
            .filter((entry) => entry.name.endsWith('.csv'))
            // Unzip the CSV file to a string
            .map((csv) => {
              return {
                data: zip.entryDataSync(csv).toString('utf8')
              };
            })
            // Parse the CSV string
            .map((csv) => {
              // NOTE: parse return an array of objects, there should be only one
              csv.parsed = parse(csv.data, {
                columns: true,
                skip_empty_lines: true
              })[0];
              return csv;
            })
            // Filter out the deleted tracks
            .filter((csv) => csv.parsed.Removed !== 'Yes')
            // Clean up the track object for consumption by the rest of the app
            .map((track) => {
              return {
                name: track.parsed.Title.replace(cleanHtmlRegEx, cleanHtmlFunc),
                album: track.parsed.Album.replace(
                  cleanHtmlRegEx,
                  cleanHtmlFunc
                ),
                artist: track.parsed.Artist.replace(
                  cleanHtmlRegEx,
                  cleanHtmlFunc
                ),
                playlistIndex: parseInt(track.parsed['Playlist Index'])
              };
            })
            // Finally, sort the tracks on 'playlistIndex'
            .sort((a, b) => a.playlistIndex - b.playlistIndex);

          // Add the track list to the playlist object
          playlist.googleTracks = googleTracks;
          return playlist;
        })
        // Clean up the playlist object for consumption by the rest of the app
        .map((playlist) => {
          return {
            name: playlist.parsed.Title.replace(cleanHtmlRegEx, cleanHtmlFunc),
            description: playlist.parsed.Description.replace(
              cleanHtmlRegEx,
              cleanHtmlFunc
            ),
            googleTracks: playlist.googleTracks
          };
        })
        // Finally, sort the playlists on 'name'
        .sort((a, b) => {
          if (a.name < b.name) return -1;
          if (a.name > b.name) return 1;
          return 0;
        });

      // Update the session token with the playlists
      req.session.googlePlaylists = googlePlaylists;

      // Close the zip file
      zip.close();

      // Redirect to /playlist to display the playlists
      res.redirect('/playlist');
    });
  });
});

/////////////////////////////////////////////
// Spotify Authorization Routes
/////////////////////////////////////////////

// Login route, borrowed from the Spotify example code
app.get('/login', (req, res) => {
  console.log(
    `/login route called with host of ${req.protocol}://${req.hostname}:${port}`
  );
  const state = generateRandomString(16);
  req.session[stateKey] = state;

  // Building the redirect_uri from scratch to make it less reliant on .env
  const new_redirect_uri = `${req.protocol}://${req.hostname}:${port}/callback`;

  // your application requests authorization
  const scope = [
    'user-read-private',
    'user-read-email',
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private'
  ].join(' ');
  res.redirect(
    'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id: client_id,
        scope: scope,
        redirect_uri: new_redirect_uri,
        state: state
      })
  );
});

// Callback route, borrowed from the Spotify example code
app.get('/callback', (req, res) => {
  // Using callback function from: https://github.com/spotify/web-api-auth-examples/issues/55

  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.session[stateKey] ? req.session[stateKey] : null;

  if (state === null || state !== storedState) {
    // res.redirect(
    //   '/#' +
    //     queryString.stringify({
    //       error: 'state_mismatch'
    //     })
    // );
    res.send(`state (${state}) does not match storedState (${storedState})`);
    return;
  }

  req.session[stateKey] = null;

  axios({
    url: 'https://accounts.spotify.com/api/token',
    method: 'post',
    params: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code'
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    auth: {
      username: client_id,
      password: client_secret
    }
  })
    .then(async (response) => {
      // Add the tokens to the session data
      req.session.tokens = {
        access: response.data.access_token,
        refresh: response.data.refresh_token,
        // expires_in is number of seconds until expiration
        // Date.now() returns the current timestamp in milliseconds
        // going to keep expiration in milliseconds to make things simpler
        expiration: response.data.expires_in * 1000 + Date.now()
      };

      // Get the user data
      const userData = await getSpotifyData(
        'https://api.spotify.com/v1/me',
        req.session.tokens
      );
      req.session.user = userData;

      // Redirect to the root
      res.redirect('/');
    })
    .catch((err) => {
      console.log(err);
    });
});

// User route
app.get('/user', (req, res) => {
  // Do nothing other than render the user template
  res.render('user', { user: req.session.user });
});

// Refresh Token route, from Spotify example code
app.get('/refresh_token', (req, res) => {
  // requesting access token from refresh token
  const refresh_token = req.session.tokens.refresh;
  const redirect = req.query.redirect;

  axios({
    url: 'https://accounts.spotify.com/api/token',
    method: 'post',
    params: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    auth: {
      username: client_id,
      password: client_secret
    }
  })
    .then(async (response) => {
      // Update the access token and expiration to the session data
      req.session.tokens.access = response.data.access_token;
      req.session.tokens.expiration =
        response.data.expires_in * 1000 + Date.now();

      // If a redirect path was given...
      if (redirect) {
        // ... clean it up a bit since redirecting to a non get route doesn't work for me
        // I want to turn the path into one of the following:
        let redirectPath = '/';
        //   "/playlist/:playlistId/track/:trackId"
        let trackMatch = redirect.match(/^(\/playlist\/[0-9]+\/track\/[0-9]+)/);
        //   "/playlist/:playlistId"
        let playlistMatch = redirect.match(/^(\/playlist\/[0-9]+)/);
        //   "/playlist"
        let libraryMatch = redirect.match(/^(\/playlist)/);
        if (trackMatch) {
          redirectPath = trackMatch[1];
        } else if (playlistMatch) {
          redirectPath = playlistMatch[1];
        } else if (libraryMatch) {
          redirectPath = libraryMatch[1];
        } else {
          redirectPath = '/';
        }

        // ... redirect there
        res.redirect(redirectPath);
      } else {
        // ... else, redirect to the root
        res.redirect('/');
      }
    })
    .catch((err) => {
      console.log(err);
    });
});

app.listen(port, () =>
  console.log(`App listening at http://localhost:${port}`)
);

// -------------------------------------------
// Utils section, should go in a separate file
// -------------------------------------------

const getSpotifyData = async (apiEndpoint, tokens, params) => {
  try {
    // console.log(`Sending GET request to ${apiEndpoint}`);
    const paramsData = params ? params : {};
    const resp = await axios({
      method: 'get',
      url: apiEndpoint,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${tokens.access}`
      },
      params: paramsData
    });
    return resp.data;
  } catch (err) {
    if (err.response.status === 429) {
      // Delay 'retry-after' seconds and try again
      const retryDelay = (delaySeconds) =>
        new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      await retryDelay(err.response.headers['retry-after']);
      return await getSpotifyData(apiEndpoint, tokens, params);
    } else {
      console.error(err);
    }

    return err;
  }
};

const postSpotifyData = async (apiEndpoint, tokens, bodyData) => {
  try {
    // console.log(`Sending POST request to ${apiEndpoint}`);
    const resp = await axios({
      method: 'post',
      url: apiEndpoint,
      data: bodyData,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${tokens.access}`
      }
    });
    return resp.data;
  } catch (err) {
    console.error(err);
  }
};

// TODO: Refactor to stop repeating myself with each *SpotifyData function
const putSpotifyData = async (apiEndpoint, tokens, bodyData) => {
  try {
    // console.log(`Sending POST request to ${apiEndpoint}`);
    const resp = await axios({
      method: 'put',
      url: apiEndpoint,
      data: bodyData,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${tokens.access}`
      }
    });
    return resp.data;
  } catch (err) {
    console.error(err);
  }
};

// Clean up HTML special entities
const cleanHtmlRegEx = /&(#([0-9]+)|([a-z]+));/g;
const specialEntities = {
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>'
};
const cleanHtmlFunc = (match, p1, p2, p3) => {
  // It is a decimal unicode value if p2 is defined
  if (p2) {
    return String.fromCharCode(p2);
  } else if (p3) {
    // HTML 4 special entities
    if (specialEntities[p3]) {
      return specialEntities[p3];
    }
  }
  console.log(`ERROR: Don't know how to clean up ${match}`);
  return match;
};

// Common search function
// Input (searchTerms) is an object with possible fields: track, artist, album
const spotifySearch = async (searchTerms, spotifyTokens) => {
  // Handle special characters in the search terms
  const specialCharsRegex = /'/g;
  // Track names sometimes have a featured artist parenthetical
  const featuringRegex = /\(.*feat.*\)/g;
  // Albums sometimes have a special release parenthetical
  const specialReleaseRegex = /\(.*deluxe.*\)/gi;
  // Clean up the search terms a bit
  const searchTrack = searchTerms.track
    .replace(specialCharsRegex, '')
    .replace(featuringRegex, '');
  const searchArtist = searchTerms.artist.replace(specialCharsRegex, '');
  const searchAlbum = searchTerms.album
    .replace(specialCharsRegex, '')
    .replace(specialReleaseRegex, '');

  // Create the search string
  const searchString = [
    searchTrack ? `track:${searchTrack}` : '',
    searchArtist ? `artist:${searchArtist}` : '',
    searchAlbum ? `album:${searchAlbum}` : ''
  ]
    .filter((term) => term !== '')
    .join(' ');

  // Get the results
  const searchResults = await getSpotifyData(
    'https://api.spotify.com/v1/search',
    spotifyTokens,
    {
      q: searchString,
      type: 'track'
    }
  );

  // Return the results
  return searchResults.tracks.items;
};
