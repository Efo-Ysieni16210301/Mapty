'use strict';

const ICONS = { running: '🏃‍♂️', cycling: '🚴‍♀️' };

// Nominatim's public API is rate-limited to ~1 request/second and is meant
// for light, non-commercial use. That's fine for a personal project like
// this, but swap in a paid geocoder (or self-hosted Nominatim) for anything
// with real traffic.
const GEOCODE_DELAY_MS = 1100;

class Workout {
  date = new Date();
  id = (Date.now() + '').slice(-10);
  clicks = 0;
  location = '';

  constructor(coords, distance, duration) {
    this.coords = coords; // [lat, lng]
    this.distance = distance; // in km
    this.duration = duration; // in min
  }

  get icon() {
    return ICONS[this.type];
  }

  _setDescription() {
    const formatted = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
    }).format(this.date);

    this.description = `${this.type[0].toUpperCase()}${this.type.slice(1)} on ${formatted}`;
  }

  click() {
    this.clicks++;
  }
}

class Running extends Workout {
  type = 'running';

  constructor(coords, distance, duration, cadence) {
    super(coords, distance, duration);
    this.cadence = cadence;
    this.calcPace();
    this._setDescription();
  }

  calcPace() {
    // min/km
    this.pace = this.duration / this.distance;
    return this.pace;
  }
}

class Cycling extends Workout {
  type = 'cycling';

  constructor(coords, distance, duration, elevationGain) {
    super(coords, distance, duration);
    this.elevationGain = elevationGain;
    this.calcSpeed();
    this._setDescription();
  }

  calcSpeed() {
    // km/h
    this.speed = this.distance / (this.duration / 60);
    return this.speed;
  }
}

///////////////////////////////////////
// APPLICATION ARCHITECTURE
const form = document.querySelector('.form');
const formError = document.querySelector('.form__error');
const containerWorkouts = document.querySelector('.workouts');
const workoutsToolbar = document.querySelector('.workouts-toolbar');
const sortSelect = document.querySelector('.sort__select');
const btnFit = document.querySelector('.btn-fit');
const btnClear = document.querySelector('.btn-clear');
const inputType = document.querySelector('.form__input--type');
const inputDistance = document.querySelector('.form__input--distance');
const inputDuration = document.querySelector('.form__input--duration');
const inputCadence = document.querySelector('.form__input--cadence');
const inputElevation = document.querySelector('.form__input--elevation');

class App {
  #map;
  #mapZoomLevel = 13;
  #mapEvent;
  #workouts = [];
  #markers = new Map(); // workout id -> Leaflet marker
  #editingId = null;

  constructor() {
    this._getPosition();
    this._getLocalStorage();
    this._backfillLocations(); // fire-and-forget, throttled

    form.addEventListener('submit', this._newWorkout.bind(this));
    inputType.addEventListener('change', this._toggleElevationField);
    containerWorkouts.addEventListener('click', this._onWorkoutClick.bind(this));
    sortSelect.addEventListener('change', () => this._renderWorkoutList());
    btnFit.addEventListener('click', () => this._fitMapToWorkouts());
    btnClear.addEventListener('click', () => this._clearAll());
  }

  // ---------- MAP SETUP ----------

  _getPosition() {
    const saved = this._getSavedView();
    if (saved) return this._loadMap({ coords: { latitude: saved.lat, longitude: saved.lng } }, saved.zoom);

    if (!navigator.geolocation) return this._loadMap(this._defaultPosition());

    navigator.geolocation.getCurrentPosition(
      pos => this._loadMap(pos),
      () => this._loadMap(this._defaultPosition())
    );
  }

  _defaultPosition() {
    return { coords: { latitude: 51.505, longitude: -0.09 } }; // London fallback
  }

  _loadMap(position, zoom = this.#mapZoomLevel) {
    const { latitude, longitude } = position.coords;
    const coords = [latitude, longitude];

    this.#map = L.map('map').setView(coords, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.#map);

    this.#map.on('click', this._showForm.bind(this));
    this.#map.on('moveend', this._saveMapView.bind(this));

    this.#workouts.forEach(work => this._renderWorkoutMarker(work));
  }

  _saveMapView() {
    const c = this.#map.getCenter();
    localStorage.setItem(
      'mapView',
      JSON.stringify({ lat: c.lat, lng: c.lng, zoom: this.#map.getZoom() })
    );
  }

  _getSavedView() {
    try {
      return JSON.parse(localStorage.getItem('mapView'));
    } catch {
      return null;
    }
  }

  _fitMapToWorkouts() {
    if (!this.#map || !this.#workouts.length) return;
    const bounds = L.latLngBounds(this.#workouts.map(w => w.coords));
    this.#map.fitBounds(bounds, { padding: [40, 40] });
  }

  // ---------- FORM ----------

  _showForm(mapE) {
    this.#mapEvent = mapE;
    this.#editingId = null;
    this._hideError();
    form.classList.remove('hidden');
    inputDistance.focus();
  }

  _hideForm() {
    inputDistance.value = inputDuration.value = inputCadence.value = inputElevation.value = '';
    form.style.display = 'none';
    form.classList.add('hidden');
    setTimeout(() => (form.style.display = 'grid'), 1000);
  }

  _toggleElevationField() {
    inputElevation.closest('.form__row').classList.toggle('form__row--hidden');
    inputCadence.closest('.form__row').classList.toggle('form__row--hidden');
  }

  _setFormType(type) {
    inputType.value = type;
    const isRunning = type === 'running';
    inputCadence.closest('.form__row').classList.toggle('form__row--hidden', !isRunning);
    inputElevation.closest('.form__row').classList.toggle('form__row--hidden', isRunning);
  }

  _showError(message) {
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  _hideError() {
    formError.classList.add('hidden');
  }

  _startEdit(id) {
    const workout = this.#workouts.find(w => w.id === id);
    if (!workout) return;

    this.#editingId = id;
    this._hideError();
    this._setFormType(workout.type);
    inputDistance.value = workout.distance;
    inputDuration.value = workout.duration;
    if (workout.type === 'running') inputCadence.value = workout.cadence;
    else inputElevation.value = workout.elevationGain;

    form.style.display = 'grid';
    form.classList.remove('hidden');
    inputDistance.focus();
  }

  _newWorkout(e) {
    e.preventDefault();
    this._hideError();

    const validInputs = (...inputs) => inputs.every(inp => Number.isFinite(inp));
    const allPositive = (...inputs) => inputs.every(inp => inp > 0);

    const type = inputType.value;
    const distance = +inputDistance.value;
    const duration = +inputDuration.value;

    const existing = this.#editingId ? this.#workouts.find(w => w.id === this.#editingId) : null;
    const coords = existing ? existing.coords : this.#mapEvent && [this.#mapEvent.latlng.lat, this.#mapEvent.latlng.lng];

    if (!coords) return this._showError('Click the map to choose a location first.');

    let workout;

    if (type === 'running') {
      const cadence = +inputCadence.value;
      if (!validInputs(distance, duration, cadence) || !allPositive(distance, duration, cadence))
        return this._showError('Inputs have to be positive numbers!');
      workout = new Running(coords, distance, duration, cadence);
    }

    if (type === 'cycling') {
      const elevation = +inputElevation.value;
      if (!validInputs(distance, duration, elevation) || !allPositive(distance, duration))
        return this._showError('Inputs have to be positive numbers!');
      workout = new Cycling(coords, distance, duration, elevation);
    }

    if (existing) {
      // Keep the workout's identity/history, swap in the recalculated stats
      workout.id = existing.id;
      workout.date = existing.date;
      workout.location = existing.location;
      workout.clicks = existing.clicks;

      const index = this.#workouts.findIndex(w => w.id === existing.id);
      this.#workouts[index] = workout;

      this.#markers.get(existing.id)?.remove();
      this.#markers.delete(existing.id);
      this.#editingId = null;
    } else {
      this.#workouts.push(workout);
      this._reverseGeocode(workout);
    }

    this._renderWorkoutMarker(workout);
    this._renderWorkoutList();
    this._hideForm();
    this._setLocalStorage();
  }

  // ---------- RENDERING ----------

  _onWorkoutClick(e) {
    const deleteBtn = e.target.closest('.workout__delete');
    if (deleteBtn) {
      e.stopPropagation();
      this._deleteWorkout(deleteBtn.dataset.id);
      return;
    }

    const editBtn = e.target.closest('.workout__edit');
    if (editBtn) {
      e.stopPropagation();
      this._startEdit(editBtn.dataset.id);
      return;
    }

    this._moveToPopup(e);
  }

  _deleteWorkout(id) {
    const workout = this.#workouts.find(w => w.id === id);
    if (!workout) return;
    if (!confirm(`Delete "${workout.description}"?`)) return;

    this.#markers.get(id)?.remove();
    this.#markers.delete(id);
    this.#workouts = this.#workouts.filter(w => w.id !== id);

    if (this.#editingId === id) {
      this.#editingId = null;
      this._hideForm();
    }

    this._renderWorkoutList();
    this._setLocalStorage();
  }

  _clearAll() {
    if (!this.#workouts.length) return;
    if (!confirm('Delete all workouts? This cannot be undone.')) return;

    this.#markers.forEach(marker => marker.remove());
    this.#markers.clear();
    this.#workouts = [];
    this.#editingId = null;

    this._renderWorkoutList();
    this._hideForm();
    this._hideError();
    localStorage.removeItem('workouts');
  }

  _moveToPopup(e) {
    if (!this.#map) return;

    const workoutEl = e.target.closest('.workout');
    if (!workoutEl) return;

    const workout = this.#workouts.find(work => work.id === workoutEl.dataset.id);
    if (!workout) return;

    this.#map.setView(workout.coords, this.#mapZoomLevel, {
      animate: true,
      pan: { duration: 1 },
    });

    workout.click();
  }

  _renderWorkoutMarker(workout) {
    this.#markers.get(workout.id)?.remove();

    const marker = L.marker(workout.coords)
      .addTo(this.#map)
      .bindPopup(
        L.popup({
          maxWidth: 250,
          minWidth: 100,
          autoClose: false,
          closeOnClick: false,
          className: `${workout.type}-popup`,
        })
      )
      .setPopupContent(`${workout.icon} ${workout.description}`)
      .openPopup();

    marker.on('mouseover', () => this._setHighlight(workout.id, true));
    marker.on('mouseout', () => this._setHighlight(workout.id, false));

    this.#markers.set(workout.id, marker);
  }

  _setHighlight(id, on) {
    containerWorkouts
      .querySelector(`[data-id="${id}"]`)
      ?.classList.toggle('workout--highlighted', on);
  }

  _getSortedWorkouts() {
    const key = sortSelect.value;
    if (key === 'distance' || key === 'duration')
      return [...this.#workouts].sort((a, b) => b[key] - a[key]);
    return [...this.#workouts].reverse(); // 'default': newest first
  }

  _workoutHTML(workout) {
    const secondRow =
      workout.type === 'running'
        ? `
        <div class="workout__details">
          <span class="workout__icon">⚡️</span>
          <span class="workout__value">${workout.pace.toFixed(1)}</span>
          <span class="workout__unit">min/km</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">🦶🏼</span>
          <span class="workout__value">${workout.cadence}</span>
          <span class="workout__unit">spm</span>
        </div>`
        : `
        <div class="workout__details">
          <span class="workout__icon">⚡️</span>
          <span class="workout__value">${workout.speed.toFixed(1)}</span>
          <span class="workout__unit">km/h</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">⛰</span>
          <span class="workout__value">${workout.elevationGain}</span>
          <span class="workout__unit">m</span>
        </div>`;

    return `
      <li class="workout workout--${workout.type}" data-id="${workout.id}">
        <h2 class="workout__title">
          ${workout.description}
          <button type="button" class="workout__edit" data-id="${workout.id}" aria-label="Edit workout">✏️</button>
          <button type="button" class="workout__delete" data-id="${workout.id}" aria-label="Delete workout">🗑️</button>
        </h2>
        ${workout.location ? `<p class="workout__location">${workout.location}</p>` : ''}
        <div class="workout__details">
          <span class="workout__icon">${workout.icon}</span>
          <span class="workout__value">${workout.distance}</span>
          <span class="workout__unit">km</span>
        </div>
        <div class="workout__details">
          <span class="workout__icon">⏱</span>
          <span class="workout__value">${workout.duration}</span>
          <span class="workout__unit">min</span>
        </div>
        ${secondRow}
      </li>`;
  }

  _renderWorkoutList() {
    containerWorkouts.querySelectorAll('.workout').forEach(el => el.remove());
    const html = this._getSortedWorkouts().map(w => this._workoutHTML(w)).join('');
    form.insertAdjacentHTML('afterend', html);
    workoutsToolbar.classList.toggle('hidden', this.#workouts.length === 0);
  }

  // ---------- LOCATION NAMES ----------

  async _reverseGeocode(workout) {
    try {
      const [lat, lng] = workout.coords;
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10`
      );
      if (!res.ok) return;

      const data = await res.json();
      const a = data.address || {};
      const place = a.city || a.town || a.village || a.suburb || a.county;
      const region = a.state || a.country;
      const name = [place, region].filter(Boolean).join(', ');
      if (!name) return;

      workout.location = name;
      this._setLocalStorage();
      this._renderWorkoutList();
    } catch {
      // Location name is a nice-to-have — fail silently if offline/blocked.
    }
  }

  async _backfillLocations() {
    for (const workout of this.#workouts) {
      if (workout.location) continue;
      await this._reverseGeocode(workout);
      await new Promise(resolve => setTimeout(resolve, GEOCODE_DELAY_MS));
    }
  }

  // ---------- PERSISTENCE ----------

  _setLocalStorage() {
    localStorage.setItem('workouts', JSON.stringify(this.#workouts));
  }

  // Plain objects read back from localStorage lose their class (and so
  // methods like calcPace/icon), so rebuild proper Running/Cycling instances.
  _getLocalStorage() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem('workouts'));
    } catch {
      return;
    }

    if (!data) return;

    this.#workouts = data.map(work => {
      const rebuilt =
        work.type === 'running'
          ? new Running(work.coords, work.distance, work.duration, work.cadence)
          : new Cycling(work.coords, work.distance, work.duration, work.elevationGain);

      return Object.assign(rebuilt, {
        id: work.id,
        date: new Date(work.date),
        clicks: work.clicks,
        location: work.location || '',
      });
    });

    this._renderWorkoutList();
  }

  reset() {
    localStorage.removeItem('workouts');
    localStorage.removeItem('mapView');
    location.reload();
  }
}

const app = new App();