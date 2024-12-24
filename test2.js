"use strict";

const btn = document.querySelector(".btn-country");
const countriesContainer = document.querySelector(".countries");
const searchBtn = document.getElementById("search-btn");
const countryInput = document.getElementById("country-input");

const renderError = function (msg) {
  countriesContainer.insertAdjacentText("beforeend", msg);
  countriesContainer.style.opacity = 1;
};

const renderCountry = function (data, classname = "") {
  const html = `
    <article class="country ${classname}">
      <img class="country__img" src="${data.flags.png}" />
      <div class="country__data">
        <h3 class="country__name">${data.name?.common || data.name}</h3>
        <h4 class="country__region">${data.region}</h4>
        <p class="country__row"><span>👫</span>${(
          data.population / 1_000_000
        ).toFixed(1)} million people</p>
        <p class="country__row"><span>🗣️</span>${Object.values(
          data.languages
        ).join(", ")}</p>
        <p class="country__row"><span>💰</span>${
          Object.values(data.currencies)[0].name
        }</p>
        <p class="country__row"><span>🕒</span>${
          Object.values(data.timezones)[0]
        }</p>
        <p class="country__row"><span>🏛️</span>${
          data.capital ? data.capital.join(", ") : "N/A"
        }</p>
      </div>
    </article>
  `;
  countriesContainer.insertAdjacentHTML("beforeend", html);
  countriesContainer.style.opacity = 1;
};

const getJSON = function (url, errormsg = "requested url not found") {
  const request1 = fetch(url).then((response) => {
    if (!response.ok)
      throw new Error(`country not found ${errormsg} ${response.status}`);
    return response.json();
  });
  return request1;
};

getJSON("https://restcountries.com/v3.1/name/india1", "country not found");

const getCountryData = function (country) {
  countriesContainer.innerHTML = "";
  fetch(`https://restcountries.com/v3.1/name/${country}`)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Country not found (${res.status})`);
      }
      return res.json();
    })
    .then((data) => {
      renderCountry(data[0]);

      // Get the first neighbor (if exists)
      const neighbour = data[0].borders?.[0];
      if (!neighbour) return;

      // Fetch neighbor country data
      return fetch(`https://restcountries.com/v2/alpha/${neighbour}`);
    })
    .then((res) => {
      if (!res) return;
      return res.json();
    })
    .then((data) => {
      if (!data) return;

      const neighborname = data.name; // Fix variable declaration

      fetch(`https://restcountries.com/v3.1/name/${neighborname}`)
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Neighbor country not found (${res.status})`);
          }
          return res.json();
        })
        .then((data) => {
          renderCountry(data[0], "neighbour");
        });
    })
    .catch((err) => {
      console.error(`${err}`);
      renderError(`Something went wrong: ${err.message}`);
    });
};

// Event listener for button click to fetch country data
searchBtn.addEventListener("click", function () {
  const country = countryInput.value.trim();

  if (country) {
    getCountryData(country);
    countryInput.value = ""; // Clear input field after search
  }
});

const newpromise = new Promise((resolve, reject) => {
  if (Math.random() >= 0.5) {
    resolve("YOU have won");
  } else {
    reject("you have lost");
  }
});
newpromise
  .then((result) => {
    console.log(result);
  })
  .catch((err) => {
    console.log(err.message);
  })
  .finally((final) => {
    console.log("it has ran ");
  });

console.log("it has ran ");
console.log("it has ran ");
console.log("it has ran ");
console.log("it has ran ");
