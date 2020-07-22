const express = require('express');
const app = express();
const port = 8888;

app.set('view engine', 'ejs');

// app.get('/', (req, res) => res.send('Hello World!'));
app.get('/', (req, res) => res.render('index'));

app.listen(port, () =>
  console.log(`App listening at httpL//localhost:${port}`)
);
