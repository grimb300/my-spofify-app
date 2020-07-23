const express = require('express');
const app = express();
const port = 8888;

// Get my secret shit out of .env
require('dotenv').config();

// Requires from Spotify example code
// request appears to be in the process of being deprecated, consider changing to another package:
//   https://github.com/request/request/issues/3142
const request = require('request'); // "Request" library
const cors = require('cors');
const querystring = require('querystring');
// const cookieParser = require('cookie-parser');

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
// app.get('/', (req, res) => res.send('Hello World!'));
app.get('/', (req, res) => {
  console.log(`Session (/):`);
  console.log(req.session);
  res.render('index');
});

// Login route, borrowed from the Spotify example code
app.get('/login', (req, res) => {
  console.log(`Session (/login):`);
  console.log(req.session);
  const state = generateRandomString(16);
  // res.cookie(stateKey, state);
  req.session[stateKey] = state;

  // your application requests authorization
  const scope = 'user-read-private user-read-email';
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
  console.log(`Session (/callback):`);
  console.log(req.session);
  // your application requests refresh and access tokens
  // after checking the state parameter

  const code = req.query.code || null;
  const state = req.query.state || null;
  // const storedState = req.cookies ? req.cookies[stateKey] : null;
  const storedState = req.session[stateKey] ? req.session[stateKey] : null;

  console.log(`/callback: state - ${state}, storedState - ${storedState}`);

  if (state === null || state !== storedState) {
    res.redirect('/#' + querystring.stringify({ error: 'state_mismatch' }));
  } else {
    // res.clearCookie(stateKey);
    req.session[stateKey] = null;
    // The Buffer object creation below throws a warning:
    // (node:2180) [DEP0005] DeprecationWarning: Buffer() is deprecated due to security and usability issues. Please use the
    // Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.
    const authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        Authorization:
          'Basic ' +
          new Buffer(client_id + ':' + client_secret).toString('base64')
      },
      json: true
    };

    request.post(authOptions, (error, response, body) => {
      if (!error && response.statusCode === 200) {
        console.log('Successful authorization:');
        console.log(body);

        const access_token = body.access_token,
          refresh_token = body.refresh_token;

        // Add the tokens to the session data
        req.session.access_token = access_token;
        req.session.refresh_token = refresh_token;

        // Redirect to the '/user' route
        res.redirect('/user');

        // const options = {
        //   url: 'https://api.spotify.com/v1/me',
        //   headers: { Authorization: 'Bearer ' + access_token },
        //   json: true
        // };

        // // use the access token to access the Spotify Web API
        // request.get(options, (error, response, body) => {
        //   // console.log(body);
        // });

        // // we can also pass the token to the browser to make requests from there
        // res.redirect(
        //   '/#' +
        //     querystring.stringify({
        //       access_token: access_token,
        //       refresh_token: refresh_token
        //     })
        // );
      } else {
        res.redirect('/#' + querystring.stringify({ error: 'invalid_token' }));
      }
    });
  }
});

// User route
app.get('/user', (req, res) => {
  // Check to see if we have a token
  if (req.session.access_token) {
    // Get the user data
    const options = {
      url: 'https://api.spotify.com/v1/me',
      headers: { Authorization: 'Bearer ' + req.session.access_token },
      json: true
    };

    // use the access token to access the Spotify Web API
    request.get(options, (error, response, body) => {
      if (!error && response.statusCode === 200) {
        console.log('User data successfully returned');
        console.log(body);

        // Save the user data for later and render the user page
        req.session.user = body;
        res.render('user', { user: body });
      }
    });
  }
});

// Refresh Token route, from Spotify example code
app.get('/refresh_token', (req, res) => {
  console.log(`Session (/refresh_token):`);
  console.log(req.session);
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
