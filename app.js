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
        }).sort((a, b) => a.playlistIndex - b.playlistIndex);

        // Return the playlist with track list
        playlist.tracks = googleTracks;
        return playlist;
      })
    );

    // console.log('After Promise.all');
    // console.log('All done parsing playlists and tracks');
    // console.log(googlePlaylists);

    // console.log(googlePlaylists[0].tracks);

    req.session.googlePlaylists = googlePlaylists;
  } else {
    console.log('googlePlaylists already defined');
  }
  const spotifyPlaylists = [];
  // const spotifyPlaylists = await getSpotifyData(
  //   'https//api.spotify.com/v1/me/playlists',
  //   req.session.tokens
  // );
  // console.log('Spotify playlist data:');
  // console.log(spotifyPlaylists);
  res.render('user', {
    user: req.session.user,
    googlePlaylists: req.session.googlePlaylists,
    spotifyPlaylists: spotifyPlaylists
  });
});

// Login route, borrowed from the Spotify example code
app.get('/login', (req, res) => {
  // console.log('/login route');
  const state = generateRandomString(16);
  req.session[stateKey] = state;

  // your application requests authorization
  const scope =
    'user-read-private user-read-email playlist-modify-public playlist-modify-private';
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
  // console.log('/callback route');
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

  // console.log('Sending POST request to api/token');

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
      // console.log(`Received a valid response (${response.status}) with data:`);
      // console.log(response.data);

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
  // console.log('/user route');
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

      // Render the playlists page
      res.render('playlists', {
        user: req.session.user,
        playlists: playlistsData.items
      });
    })();
  }
});

// Individual playlist route
app.get('/playlists/:id', (req, res) => {
  playlistId = req.params.id;

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
      // console.log('Rendering search_results with tracklist');
      // console.log(searchResults.tracks.items);
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
      // console.log('Rendering search_results with tracklist');
      // console.log(searchResults.tracks.items);
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
              // console.log(
              //   `Adding ${directoryName} to the googlePlaylists array`
              // );
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
    // console.log('Already imported playlists');
    // TODO: Fix async problems which force rendering down each path
    res.render('google_playlists', { playlists: req.session.googlePlaylists });
  }
});

app.get('/google_playlists/:id', async (req, res) => {
  const playlistId = req.params.id;

  // Check if there is a Spotify access token
  // Check if the googlePlaylists structure is present and if the playlistId requested is present
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If not, redirect back to the google_playlists route
    res.redirect('/google_playlists');
    return;
  } else if (!req.session.googlePlaylists[playlistId].Tracks) {
    // console.log(`Playlist ID ${playlistId} needs to load the tracklist`);

    // Read in the tracks.csv file for this playlist
    const rawTracksCSV = [];
    let googleTracks = [];
    const playlistDirectory = req.session.googlePlaylists[playlistId].Directory;
    const cleanupRegEx = /&#([0-9]+);|&([a-z]+);/g;
    const cleanupString = (match, p1, p2, offset, string) => {
      // Clean up any unicode
      if (p1) {
        return String.fromCharCode(p1);
      } else if (p2 === 'amp') {
        return '&';
      } else if (p2 === 'quot') {
        return '"';
      } else {
        console.log(`Don't know how to clean up ${match}`);
      }
    };

    fs
      .createReadStream(`./playlistCSVs/${playlistDirectory}/tracks.csv`)
      .pipe(csv())
      .on('data', (row) => {
        rawTracksCSV.push(row);
      })
      .on('end', async () => {
        googleTracks = rawTracksCSV
          // Filter out the tracks marked as Removed
          .filter((track) => track.Removed !== 'Yes')
          // Clean up the Title, Album, and Artist fields
          .map((track) => {
            track.Title = track.Title.replace(cleanupRegEx, cleanupString);
            track.Album = track.Album.replace(cleanupRegEx, cleanupString);
            track.Artist = track.Artist.replace(cleanupRegEx, cleanupString);
            return track;
          });

        // Sort based on 'Playlist Index'
        googleTracks.sort((a, b) => {
          indexA = parseInt(a['Playlist Index']);
          indexB = parseInt(b['Playlist Index']);
          return indexA - indexB;
        });

        // Add the tracklist to the playlist in the session data
        req.session.googlePlaylists[playlistId].Tracks = googleTracks;

        // TODO: Fix async problems which force rendering down each path
        res.render('google_tracklist', {
          playlist: req.session.googlePlaylists[playlistId],
          playlistId: playlistId
        });
      });
  } else {
    // TODO: Fix async problems which force rendering down each path
    res.render('google_tracklist', {
      playlist: req.session.googlePlaylists[playlistId],
      playlistId: playlistId
    });
  }
});

app.get('/google_playlists/:playlistId/track/:trackId', async (req, res) => {
  const playlistId = req.params.playlistId;
  const trackId = req.params.trackId;

  // Check if the necessary googlePlaylists structures are present
  if (
    !req.session.googlePlaylists ||
    !req.session.googlePlaylists[playlistId]
  ) {
    // If no playlist, redirect to google_playlists
    res.redirect('/google_playlists');
    return;
  } else if (!req.session.googlePlaylists[playlistId].Tracks) {
    // If not tracklist, redirect to google_playlist/<playlistId>
    res.redirect(`/google_playlists/${playlistId}`);
    return;
  } else if (!req.session.access_token) {
    // If no Spotify access token, redirect to the root
    res.redirect('/');
    return;
  } else {
    // Clean up the track/artist/album info to search in Spotify
    // Removing all parenthetical phrases as they tend to be
    // featured artists and other info that makes it hard to search
    const removeParentheticalRegEx = /\(.*\)/g;
    const origGoogleTrack =
      req.session.googlePlaylists[playlistId].Tracks[trackId];
    const cleanGoogleTrack = {};
    cleanGoogleTrack.Title = origGoogleTrack.Title.replace(
      removeParentheticalRegEx,
      ''
    );
    cleanGoogleTrack.Artist = origGoogleTrack.Artist.replace(
      removeParentheticalRegEx,
      ''
    );
    cleanGoogleTrack.Album = origGoogleTrack.Album.replace(
      removeParentheticalRegEx,
      ''
    );

    // Get Spotify search results based on the Google track info
    const searchResults = await getSpotifyData(
      'https://api.spotify.com/v1/search',
      {
        access: req.session.access_token,
        refresh: req.session.refresh_token
      },
      {
        q: `track:${cleanGoogleTrack.Title} artist:${cleanGoogleTrack.Artist} album:${cleanGoogleTrack.Album}`,
        type: 'track'
      }
    );
    // console.log('Spotify returned search results:');
    // if (searchResults.tracks.total > 0) {
    //   console.log(searchResults.tracks.items);
    // } else {
    //   console.log('No results');
    // }

    // Render the page
    res.render('google_single_track', {
      track: req.session.googlePlaylists[playlistId].Tracks[trackId],
      playlistId: playlistId,
      trackId: trackId,
      numResults: searchResults.tracks.total,
      searchResults:
        searchResults.tracks.total > 0 ? searchResults.tracks.items : {}
    });
  }
});

// Refresh Token route, from Spotify example code
app.get('/refresh_token', (req, res) => {
  // console.log(`Session (/refresh_token):`);
  // console.log(req.session);
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
  console.log(`App listening at httpL//localhost:${port}`)
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
    // console.log('Full resp object');
    // console.log(resp);
    // console.log('Got a response');
    // console.log(resp.data);
    return resp.data;
  } catch (err) {
    console.error(err);
  }
};

const postSpotifyData = async (apiEndpoint, bodyData, tokens) => {
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
    // console.log('Full resp object');
    // console.log(resp);
    // console.log('Got a response');
    // console.log(resp.data);
    return resp.data;
  } catch (err) {
    console.error(err);
  }
};
