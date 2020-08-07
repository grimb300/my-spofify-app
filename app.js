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
  req.session.spotifyPlaylists = spotifyPlaylists.items.map(
    (spotifyPlaylist) => {
      const googlePlaylistId = req.session.googlePlaylists.findIndex(
        (googlePlaylist) => googlePlaylist.title === spotifyPlaylist.name
      );
      spotifyPlaylist.googlePlaylistId = googlePlaylistId;
      return spotifyPlaylist;
    }
  );

  res.render('library', {
    user: req.session.user,
    googlePlaylists: req.session.googlePlaylists,
    spotifyPlaylists: req.session.spotifyPlaylists
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
  createdPlaylist.googlePlaylistId = playlist.id;
  req.session.spotifyPlaylists.push(createdPlaylist);

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

  // Get the Google and Spotify (if present) playlists
  const googlePlaylist = req.session.googlePlaylists[playlistId];
  const spotifyPlaylist = req.session.spotifyPlaylists.find(
    (spotifyPlaylist) => spotifyPlaylist.googlePlaylistId === playlistId
  );

  // Add Spotify tracks to the Google tracks, if necessary
  googlePlaylist.tracks = await Promise.all(
    googlePlaylist.tracks.map(async (googleTrack) => {
      // The mere presence of a 'spotifyTrack' field means don't do anything
      // if ('spotifyTrack' in Object.keys(googleTrack)) {
      if (googleTrack.spotifyTrack) {
        return googleTrack;
      }

      // Search Spotify based on the Google track info
      const searchString = `track:${googleTrack.title} artist:${googleTrack.artist} album:${googleTrack.album}`;
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
        googleTrack.spotifyTrack = false;
      } else if (searchResults.tracks.total === 1) {
        // If only one is returned, the choice is obvious
        googleTrack.spotifyTrack = searchResults.tracks.items[0];
      } else {
        // Find the best fit
        const bestFit = searchResults.tracks.items.find(
          (spotifyTrack) =>
            spotifyTrack.name === googleTrack.title &&
            spotifyTrack.artists.includes(googleTrack.artist) &&
            spotifyTrack.album.name === googleTrack.album
        );

        if (bestFit) {
          // If found, update spotifyTrack
          googleTrack.spotifyTrack = bestFit;
        } else {
          // Otherwise punt and take the first one in the list
          googleTrack.spotifyTrack = searchResults.tracks.items[0];
        }
      }

      // Return the updated googleTrack object
      return googleTrack;
    })
  );

  // Render this playlist
  res.render('playlist', {
    user: req.session.user,
    googlePlaylist: googlePlaylist,
    spotifyPlaylist: spotifyPlaylist,
    playlistId: playlistId
  });
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
    res.redirect('/');
    return;
  }

  // Remove the Google playlist from the library
  req.session.googlePlaylists.splice(playlistId, 1);

  // Redirect to the root route
  res.redirect(`/`);
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
  res.redirect(`/playlist/${playlistId}`);
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
  res.redirect(`/playlist/${playlistId}`);
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

// Individual Spotify playlist route
app.get('/spotify_playlists/:id', (req, res) => {
  playlistId = req.params.id;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // Redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the tracklist for this playlist
    (async () => {
      const tracksData = await getSpotifyData(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        {
          access: req.session.access_token,
          refresh: req.session.refresh_token
        }
      );

      // Render the tracklist page
      res.render('tracklist', {
        user: req.session.user,
        tracklist: tracksData.items
      });
    })();
  }
});

app.get('/search', (req, res) => {
  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the search results
    (async () => {
      const searchResults = await getSpotifyData(
        'https://api.spotify.com/v1/search?q=boulevard%20of%20broken%20dreams&type=track',
        {
          access: req.session.access_token,
          refresh: req.session.refresh_token
        }
      );

      // Render the search results page
      res.render('search_results', {
        tracklist: searchResults.tracks.items
      });
    })();
  }
});

app.get('/create_playlist', (req, res) => {
  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the search results
    (async () => {
      const searchResults = await postSpotifyData(
        `https://api.spotify.com/v1/users/${req.session.user.id}/playlists`,
        {
          name: 'Created Playlist'
        },
        {
          access: req.session.access_token,
          refresh: req.session.refresh_token
        }
      );

      // Render the search results page
      res.render('search_results', {
        tracklist: searchResults.tracks.items
      });
    })();
  }
});

app.get('/google_playlists', async (req, res) => {
  // If we already have the top level playlist data, no need to import it again
  if (!req.session.googlePlaylists) {
    // Read in the playlist.csv file
    const rawPlaylistsCSV = [];
    let googlePlaylists = [];
    fs
      .createReadStream(`./playlistCSVs/playlists.csv`)
      .pipe(csv())
      .on('data', (row) => {
        rawPlaylistsCSV.push(row);
      })
      .on('end', async () => {
        // Clean up the title and description and add a directory field
        googlePlaylists = rawPlaylistsCSV.map((playlist) => {
          // The directory turns apostrophes(' or &#39;) into underscores(_)
          // and forward slashes(/) into dashes(-)
          playlist.Directory = playlist.Title
            .replace(/&#39;/g, '_')
            .replace(/\//g, '-');
          // Use fromCharCode to get the actual character
          playlist.Title = playlist.Title.replace(/&#([0-9]+);/g, (match, p1) =>
            String.fromCharCode(p1)
          );
          playlist.Description = playlist.Description.replace(
            /&#([0-9]+);/g,
            (match, p1) => String.fromCharCode(p1)
          );
          return playlist;
        });

        // Read in the contents of the playlistCSVs
        const dirContents = await fs.promises.readdir('./playlistCSVs', {
          encoding: 'utf8',
          withFileTypes: true
        });
        // Iterate over the directory contents,
        // filtering out anything that isn't a directory and
        // adding missing directories to the googlePlaylists structure
        dirContents.forEach((element) => {
          if (element.isDirectory()) {
            const directoryName = element.name;
            const matchingPlaylist = googlePlaylists.find((playlist) => {
              return playlist.Directory === directoryName;
            });
            if (matchingPlaylist === undefined) {
              googlePlaylists.push({
                Title: directoryName,
                Owner: 'Bob Grim',
                Description: '',
                Shared: '',
                Deleted: '',
                Directory: directoryName
              });
            }
          }
        });

        // Add the playlists structure to the session data
        req.session.googlePlaylists = googlePlaylists;
        // TODO: Fix async problems which force rendering down each path
        res.render('google_playlists', { playlists: googlePlaylists });
      });
  } else {
    // TODO: Fix async problems which force rendering down each path
    res.render('google_playlists', { playlists: req.session.googlePlaylists });
  }
});

app.get('/google_playlists/:id', async (req, res) => {
  const playlistId = req.params.id;

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

  // Get the Spotify tracks for each Google track
  req.session.googlePlaylists[playlistId].tracks = await Promise.all(
    req.session.googlePlaylists[playlistId].tracks.map(async (track) => {
      // If the spotify tracks already exist, return
      if (track.spotifyTracks) {
        return track;
      }

      // Clean up the track/artist/album info to search in Spotify
      // Removing all parenthetical phrases as they tend to be
      // featured artists and other info that makes it hard to search
      const removeParentheticalRegEx = /\(.*\)/g;
      // const removePunctuationRegEx = /[().!?;:,'"]/g;
      const removePunctuationRegEx = /[']/g;
      const cleanGoogleTrack = {
        title: track.title
          .replace(removeParentheticalRegEx, '')
          .replace(removePunctuationRegEx, ''),
        artist: track.artist
          .replace(removeParentheticalRegEx, '')
          .replace(removePunctuationRegEx, ''),
        album: track.album
          .replace(removeParentheticalRegEx, '')
          .replace(removePunctuationRegEx, '')
        // title: track.title.replace(removeParentheticalRegEx, ''),
        // artist: track.artist.replace(removeParentheticalRegEx, ''),
        // album: track.album.replace(removeParentheticalRegEx, '')
      };

      // Get Spotify search results based on the Google track info
      const searchString =
        `track:${cleanGoogleTrack.title} ` +
        `artist:${cleanGoogleTrack.artist} ` +
        `album:${cleanGoogleTrack.album}`;
      const searchResults = await getSpotifyData(
        'https://api.spotify.com/v1/search',
        req.session.tokens,
        {
          q: searchString,
          type: 'track'
        }
      );

      // Check how many results are returned
      if (searchResults.tracks.items.length === 0) {
        // If there are no results, just notify for now
      } else if (searchResults.tracks.items.length === 1) {
        // If there is only one result it has to be the chosen one
        searchResults.tracks.items[0].chosen = true;
      } else {
        // There are multiple results, choose the best fit
        let bestIndex = searchResults.tracks.items.find(
          (track) =>
            track.name === cleanGoogleTrack.title &&
            track.artists.includes(cleanGoogleTrack.artist) &&
            track.album.name === cleanGoogleTrack.album
        );
        if (bestIndex === -1) {
          // Pick index 0 because I don't know any better
          bestIndex = 0;
        }
        searchResults.tracks.items[0].chosen = true;
      }

      // Return the track with the search results
      track.spotifyTracks = searchResults.tracks.items;
      return track;
    })
  );

  // Render this playlist
  res.render('google_tracklist', {
    playlists: req.session.googlePlaylists,
    playlistId: playlistId
  });
});

app.get('/google_playlists/:playlistId/track/:trackId', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check for Spotify access tokens
  if (!req.session.tokens) {
    // If not, redirect to login to get new tokens
    res.redirect('/login');
    return;
  }

  // Check for Google playlists and if this playlist and track exists
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId] ||
    !req.session.googlePlaylists[playlistId].tracks[trackId]
  ) {
    // If not, redirect to the root route
    res.redirect('/');
    return;
  }

  // If the user has provided search terms, search now
  const searchString = [
    req.query.track ? `track:${req.query.track}` : '',
    req.query.artist ? `artist:${req.query.artist}` : '',
    req.query.album ? `album:${req.query.album}` : ''
  ]
    .filter((element) => element !== '')
    .join(' ');
  let searchResults = [];
  if (searchString !== '') {
    const spotifySearchResults = await getSpotifyData(
      'https://api.spotify.com/v1/search',
      req.session.tokens,
      {
        q: searchString,
        type: 'track'
      }
    );
    searchResults = spotifySearchResults.tracks.items;
  }
  req.session.googlePlaylists[playlistId].tracks[
    trackId
  ].spotifySearchString = searchString;
  req.session.googlePlaylists[playlistId].tracks[
    trackId
  ].spotifySearchResults = searchResults;

  // Render the page
  res.render('google_single_track', {
    playlists: req.session.googlePlaylists,
    playlistId: playlistId,
    trackId: trackId
  });
});

app.get(
  '/google_playlists/:playlistId/track/:trackId/pick_me/:spotifyTrackId',
  (req, res) => {
    const playlistId = req.params.playlistId;
    const trackId = req.params.trackId;
    const newSpotifyTrackId = req.params.spotifyTrackId;

    // Check that all IDs are valid
    if (
      !req.session.googlePlaylists ||
      !req.session.googlePlaylists[playlistId]
    ) {
      // If the playlist isn't valid, redirect to root route
      res.redirect('/');
      return;
    } else if (!req.session.googlePlaylists[playlistId].tracks[trackId]) {
      // If the track list isn't valid, redirect to playlist route
      res.redirect(`/google_playlists/${playlistId}`);
      return;
    } else if (
      !req.session.googlePlaylists[playlistId].tracks[trackId].spotifyTracks[
        newSpotifyTrackId
      ]
    ) {
      // If the Spotify track isn't valid, redirect to track route
      res.redirect(`/google_playlists/${playlistId}/track/${trackId}`);
      return;
    }

    // Change which Spotify track is the chosen one
    const oldSpotifyTrackId = req.session.googlePlaylists[playlistId].tracks[
      trackId
    ].spotifyTracks.findIndex((spotifyTrack) => {
      return spotifyTrack.chosen;
    });
    req.session.googlePlaylists[playlistId].tracks[trackId].spotifyTracks[
      oldSpotifyTrackId
    ].chosen = false;
    req.session.googlePlaylists[playlistId].tracks[trackId].spotifyTracks[
      newSpotifyTrackId
    ].chosen = true;

    // Redirect to the playlist route
    res.redirect(`/google_playlists/${playlistId}`);
  }
);

app.get(
  '/google_playlists/:playlistId/track/:trackId/pick_search_result/:spotifyTrackId',
  (req, res) => {
    const playlistId = req.params.playlistId;
    const trackId = req.params.trackId;
    const newSpotifyTrackId = req.params.spotifyTrackId;

    // Check that all IDs are valid
    if (
      !req.session.googlePlaylists ||
      !req.session.googlePlaylists[playlistId]
    ) {
      // If the playlist isn't valid, redirect to root route
      res.redirect('/');
      return;
    } else if (!req.session.googlePlaylists[playlistId].tracks[trackId]) {
      // If the track list isn't valid, redirect to playlist route
      res.redirect(`/google_playlists/${playlistId}`);
      return;
    } else if (
      !req.session.googlePlaylists[playlistId].tracks[trackId]
        .spotifySearchResults[newSpotifyTrackId]
    ) {
      // If the Spotify track isn't valid, redirect to track route
      res.redirect(`/google_playlists/${playlistId}/track/${trackId}`);
      return;
    }

    // Change which Spotify track is the chosen one
    const oldSpotifyTrackId = req.session.googlePlaylists[playlistId].tracks[
      trackId
    ].spotifyTracks.findIndex((spotifyTrack) => {
      return spotifyTrack.chosen;
    });
    req.session.googlePlaylists[playlistId].tracks[trackId].spotifyTracks[
      oldSpotifyTrackId
    ].chosen = false;
    req.session.googlePlaylists[playlistId].tracks[
      trackId
    ].spotifySearchResults[newSpotifyTrackId].chosen = true;

    // Last step that is unique to this route is to copy the chosen search result to the spotifyTracks array
    req.session.googlePlaylists[playlistId].tracks[trackId].spotifyTracks.push(
      req.session.googlePlaylists[playlistId].tracks[trackId]
        .spotifySearchResults[newSpotifyTrackId]
    );

    // Redirect to the playlist route
    res.redirect(`/google_playlists/${playlistId}`);
  }
);

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
    console.log(`Sending GET request to ${apiEndpoint}`);
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
    console.error(err);
  }
};

const postSpotifyData = async (apiEndpoint, tokens, bodyData) => {
  try {
    console.log(`Sending PUT request to ${apiEndpoint}`);
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
