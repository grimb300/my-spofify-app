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
const redirect_uri = 'http://localhost:8888/callback'; // Your redirect uri

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

// Root route
app.get('/', async (req, res) => {
  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // Redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists
  if (!req.session.googlePlaylists) {
    // Create an empty array for the playlist
    req.session.googlePlaylists = [];

    // Clean up HTML special entities
    const cleanHtmlRegEx = /&(#([0-9]+)|([a-z]+));/g;
    const cleanHtmlFunc = (match, p1, p2, p3) => {
      // It is a decimal unicode value if p2 is defined
      if (p2) {
        return String.fromCharCode(p2);
      } else if (p3) {
        // HTML 4 special entities
        if (p3 === 'amp') {
          return '&';
        } else if (p3 === 'quot') {
          return '"';
        }
      }
      console.log(`ERROR: Don't know how to clean up ${match}`);
      return match;
    };

    // Read in the playlists.csv file
    const playlistsDir = './playlistCSVs';
    const playlistsCsvFile = `${playlistsDir}/playlists.csv`;

    // Trying a new method

    // Read in the playlists CSV
    const playlistsFileHandle = await fsPromises.open(playlistsCsvFile);
    const playlistsData = await playlistsFileHandle.readFile('utf8');
    await playlistsFileHandle.close();
    let googlePlaylists = parse(playlistsData, {
      columns: true,
      on_record: (playlist) => {
        // If deleted, return null
        if (playlist.Deleted === 'Yes') {
          return null;
        }

        // Clean up the Title and Description text
        const title = playlist.Title.replace(cleanHtmlRegEx, cleanHtmlFunc);
        const description = playlist.Description.replace(
          cleanHtmlRegEx,
          cleanHtmlFunc
        );

        // The directory further cleans up of the title
        //    - apostrophes(') turn into underscores(_)
        //    - slashes(/) turn into dashes(-)
        const directory = title.replace(/'/g, '_').replace(/\//g, '-');

        // Return the modified record
        return {
          title: title,
          description: description,
          directory: directory,
          // Create an empty array for the tracks
          tracks: []
        };
      },
      skip_empty_lines: true
    });

    // Add in any extra directories not in the the CSV
    const dirContents = await fsPromises.readdir(playlistsDir, {
      encoding: 'utf8',
      withFileTypes: true
    });
    const newPlaylists = dirContents
      // Filter to get only directories that aren't already in googlePlaylists
      .filter(
        (file) =>
          file.isDirectory() &&
          googlePlaylists.find(
            (playlist) => playlist.directory === file.name
          ) === undefined
      )
      // Add new directories to the playlist structure
      .forEach((playlistDir) =>
        googlePlaylists.push({
          title: playlistDir.name,
          description: '',
          directory: playlistDir.name,
          tracks: []
        })
      );

    // Add the track list to each playlist
    // Has to be wrapped in an await Promise.all() because the mapping function is async
    googlePlaylists = await Promise.all(
      googlePlaylists.map(async (playlist) => {
        // Read in the tracks CSV
        const tracksCsvFile = `${playlistsDir}/${playlist.directory}/tracks.csv`;
        const tracksFileHandle = await fsPromises.open(tracksCsvFile);
        const tracksData = await tracksFileHandle.readFile('utf8');
        await tracksFileHandle.close();
        const googleTracks = parse(tracksData, {
          columns: true,
          on_record: (track) => {
            // If deleted, return null
            if (track.Removed === 'Yes') {
              return null;
            }

            // Return the modified record
            return {
              // Clean up the Title, Album and Artist text
              title: track.Title.replace(cleanHtmlRegEx, cleanHtmlFunc),
              album: track.Album.replace(cleanHtmlRegEx, cleanHtmlFunc),
              artist: track.Artist.replace(cleanHtmlRegEx, cleanHtmlFunc),
              // Convert the playlist index from string to int
              playlistIndex: parseInt(track['Playlist Index'])
            };
          },
          skip_empty_lines: true
        })
          // Sort the tracks on playlistIndex
          .sort((a, b) => a.playlistIndex - b.playlistIndex);

        // Return the playlist with track list
        playlist.tracks = googleTracks;
        return playlist;
      })
    );

    req.session.googlePlaylists = googlePlaylists;
  }

  // Get the user's Spotify playlists
  const spotifyPlaylists = await getSpotifyData(
    'https://api.spotify.com/v1/me/playlists',
    req.session.tokens
  );

  // Map the Spotify playlists onto the Google playlists
  req.session.googlePlaylists = req.session.googlePlaylists.map(
    (googlePlaylist) => {
      let updatedSpotifyPlaylist = undefined;

      // If there is already a spotifyPlaylist associated with this googlePlaylist
      if (googlePlaylist.spotifyPlaylist) {
        // Find the matching playlist based on Spotify playlist ID
        updatedSpotifyPlaylist = spotifyPlaylists.items.find(
          (spotifyPlaylist) =>
            googlePlaylist.spotifyPlaylist.id === spotifyPlaylist.id
        );
      }

      // If the updated Spotify playlist is still undefined
      if (!updatedSpotifyPlaylist) {
        // Find the matching playlist based on the playlist title
        updatedSpotifyPlaylist = spotifyPlaylists.items.find(
          (spotifyPlaylist) => googlePlaylist.title === spotifyPlaylist.name
        );
      }

      // Update the spotifyPlaylist and return
      googlePlaylist.spotifyPlaylist = updatedSpotifyPlaylist;
      return googlePlaylist;
    }
  );

  res.render('library', {
    user: req.session.user,
    googlePlaylists: req.session.googlePlaylists
  });
});

app.post('/playlist/add', async (req, res) => {
  // Get the particulars for the new Spotify playlist out of the request body
  const playlist = req.body.playlist;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // Redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlist.id]
  ) {
    // If not, redirect back to the root route
    res.redirect('/');
    return;
  }

  // Create the playlist
  const userId = req.session.user.id;
  const createdPlaylist = await postSpotifyData(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    req.session.tokens,
    {
      name: playlist.title,
      description: playlist.description
    }
  );
  req.session.googlePlaylists[playlist.id].spotifyPlaylist = createdPlaylist;

  res.redirect(`/playlist/${playlist.id}`);
});

app.get('/playlist/:id', async (req, res) => {
  const playlistId = req.params.id;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // Redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the root route
    res.redirect('/');
    return;
  }

  // Get the Google playlist
  const googlePlaylist = req.session.googlePlaylists[playlistId];

  // Filter out the tracks that already have a spotifyTrack
  // No need to search for them again
  let searchTracks = googlePlaylist.tracks.filter(
    (track) => !track.spotifyTrack
  );

  // Get current timestamp for perf reasons
  const startTime = performance.now();

  searchTracks = await Promise.all(
    searchTracks.map(async (track) => {
      // Search Spotify based on the Google track info
      const searchString = `track:${track.title} artist:${track.artist} album:${track.album}`;
      const searchResults = await getSpotifyData(
        'https://api.spotify.com/v1/search',
        req.session.tokens,
        {
          q: searchString,
          type: 'track'
        }
      );

      // Check the results
      if (searchResults.tracks.total === 0) {
        // If no results, set spotifyTrack to false (so it is definitely falsey)
        track.spotifyTrack = false;
      } else if (searchResults.tracks.total === 1) {
        // If only one is returned, the choice is obvious
        track.spotifyTrack = searchResults.tracks.items[0];
      } else {
        // Find the best fit
        const bestFit = searchResults.tracks.items.find(
          (spotifyTrack) =>
            spotifyTrack.name === track.title &&
            spotifyTrack.artists.includes(track.artist) &&
            spotifyTrack.album.name === track.album
        );

        if (bestFit) {
          // If found, update spotifyTrack
          track.spotifyTrack = bestFit;
        } else {
          // Otherwise punt and take the first one in the list
          track.spotifyTrack = searchResults.tracks.items[0];
        }
      }
    })
  );

  // Render this playlist
  res.render('playlist', {
    user: req.session.user,
    googlePlaylist: googlePlaylist,
    playlistId: playlistId
  });
});

app.post('/playlist/:playlistId/upload', async (req, res) => {
  const playlistId = req.params.playlistId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist exists and if this playlist has an associated Spotify playlist
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId] ||
    !req.session.googlePlaylists[playlistId].spotifyPlaylist
  ) {
    // If not, redirect back to the root route
    res.redirect(`/`);
    return;
  }

  // Get the Spotify playlist ID to be updated and track URIs to add
  const spotifyPlaylistId =
    req.session.googlePlaylists[playlistId].spotifyPlaylist.id;
  const spotifyTrackUris = req.session.googlePlaylists[playlistId].tracks
    // Map each google track to its Spotify URI
    .map((track) => {
      if (track.spotifyTrack) {
        return track.spotifyTrack.uri;
      }
      return null;
    })
    // Filter out any null tracks
    .filter((track) => track !== null);

  // The Spotify endpoint is limited to 100 tracks added at a time, loop appropriately
  for (
    let startIndex = 0;
    startIndex < spotifyTrackUris.length;
    startIndex += 100
  ) {
    trackSlice = spotifyTrackUris.slice(startIndex, startIndex + 100);
    const updatedPlaylist = await postSpotifyData(
      `https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/tracks`,
      req.session.tokens,
      { uris: trackSlice }
    );
  }

  res.redirect('/');
});

app.post('/playlist/:playlistId/delete', async (req, res) => {
  const playlistId = req.params.playlistId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist exists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the root route
    res.redirect(`/`);
    return;
  }

  // Remove the Google playlist from the library
  req.session.googlePlaylists.splice(playlistId, 1);

  // Redirect to the root route
  res.redirect(`/#playlist-${playlistId}`);
});

app.post('/playlist/:playlistId/track/:trackId/delete', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist exists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the root route
    res.redirect('/');
    return;
  }

  // Check that this track exists
  if (
    !req.session.googlePlaylists[playlistId].tracks ||
    !req.session.googlePlaylists[playlistId].tracks[trackId]
  ) {
    // If not, redirect back to the playlist route
    res.redirect(`/playlist/${playlistId}`);
    return;
  }

  // Remove the Google track from the playlist
  req.session.googlePlaylists[playlistId].tracks.splice(trackId, 1);

  // Redirect to the playlist route
  res.redirect(`/playlist/${playlistId}#result-${trackId}`);
});

app.post('/playlist/:playlistId/track/:trackId/update', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;
  const spotifyTrackId = req.body.spotifyTrackId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist exists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the root route
    res.redirect('/');
    return;
  }

  // Check that this track exists
  if (
    !req.session.googlePlaylists[playlistId].tracks ||
    !req.session.googlePlaylists[playlistId].tracks[trackId]
  ) {
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
  req.session.googlePlaylists[playlistId].tracks[
    trackId
  ].spotifyTrack = spotifyTrack;

  // Redirect to the playlist route
  res.redirect(`/playlist/${playlistId}#result-${trackId}`);
});

app.get('/playlist/:playlistId/track/:trackId', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist exists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the root route
    res.redirect('/');
    return;
  }

  // Check that this track exists
  if (
    !req.session.googlePlaylists[playlistId].tracks ||
    !req.session.googlePlaylists[playlistId].tracks[trackId]
  ) {
    // If not, redirect back to the playlist route
    res.redirect(`/playlist/${playlistId}`);
    return;
  }

  // Get the Google track
  const googleTrack = req.session.googlePlaylists[playlistId].tracks[trackId];

  // Create a search based on terms provided in the query
  // If no query, default to a search based on the Google track info
  const searchTerms = req.query.search
    ? req.query.search
    : {
        track: googleTrack.title,
        artist: googleTrack.artist,
        album: googleTrack.album
      };
  const searchString = [
    searchTerms.track ? `track:${searchTerms.track}` : '',
    searchTerms.artist ? `artist:${searchTerms.artist}` : '',
    searchTerms.album ? `album:${searchTerms.album}` : ''
  ]
    .filter((term) => term !== '')
    .join(' ');

  const searchResults = await getSpotifyData(
    'https://api.spotify.com/v1/search',
    req.session.tokens,
    {
      q: searchString,
      type: 'track'
    }
  );

  // Render track.ejs
  res.render('track', {
    user: req.session.user,
    googleTrack: req.session.googlePlaylists[playlistId].tracks[trackId],
    playlistId: playlistId,
    trackId: trackId,
    searchTerms: searchTerms,
    searchResults: searchResults.tracks.items
  });
});

// Login route, borrowed from the Spotify example code
app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  req.session[stateKey] = state;

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
        redirect_uri: redirect_uri,
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
        refresh: response.data.refresh_token
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
  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the user data
    (async () => {
      const userData = await getSpotifyData('https://api.spotify.com/v1/me', {
        access: req.session.access_token,
        refresh: req.session.access_token
      });

      // Save the user data and render the user page
      req.session.user = userData;
      res.render('user', { user: userData });
    })();
  } else {
    // If no token, got back to the login screen
    res.redirect('/login');
  }
});

// Playlists route
app.get('/playlists', (req, res) => {
  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the user playlists
    (async () => {
      const playlistsData = await getSpotifyData(
        'https://api.spotify.com/v1/me/playlists',
        {
          access: req.session.access_token,
          refresh: req.session.refresh_token
        }
      );

      // Render the library page
      res.render('library', {
        user: req.session.user,
        playlists: playlistsData.items
      });
    })();
  }
});

// Refresh Token route, from Spotify example code
app.get('/refresh_token', (req, res) => {
  // requesting access token from refresh token
  var refresh_token = req.query.refresh_token;
  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: {
      Authorization:
        'Basic ' +
        new Buffer(client_id + ':' + client_secret).toString('base64')
    },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  request.post(authOptions, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      var access_token = body.access_token;
      res.send({
        access_token: access_token
      });
    }
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
