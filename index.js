import L from "leaflet";
import "./lib/Leaflet.Labeled.Circle";
import * as turf from "@turf/turf";
import { isFunction, isLevel, isEmpty, isObject } from "./utils";

/*
 * L.TileLayer.Grayscale is a regular tilelayer with grayscale makeover.
 */

L.TileLayer.Grayscale = L.TileLayer.extend({
    options: {
        quotaRed: 21,
        quotaGreen: 71,
        quotaBlue: 8,
        quotaDividerTune: 0,
        quotaDivider() {
            return (
                this.quotaRed +
                this.quotaGreen +
                this.quotaBlue +
                this.quotaDividerTune
            );
        },
    },

    initialize(url, options) {
        options.crossOrigin = true;
        L.TileLayer.prototype.initialize.call(this, url, options);

        this.on("tileload", function(e) {
            this._makeGrayscale(e.tile);
        });
    },

    _createTile() {
        const tile = L.TileLayer.prototype._createTile.call(this);
        tile.crossOrigin = "Anonymous";
        return tile;
    },

    _makeGrayscale(img) {
        if (img.getAttribute("data-grayscaled")) {
            return;
        }

        img.crossOrigin = "";
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pix = imgd.data;
        for (let i = 0, n = pix.length; i < n; i += 4) {
            pix[i] = pix[i + 1] = pix[i + 2] =
                (this.options.quotaRed * pix[i] +
                    this.options.quotaGreen * pix[i + 1] +
                    this.options.quotaBlue * pix[i + 2]) /
                this.options.quotaDivider();
        }
        ctx.putImageData(imgd, 0, 0);
        img.setAttribute("data-grayscaled", true);
        img.src = canvas.toDataURL();
    },
});

L.tileLayer.grayscale = function(url, options) {
    return new L.TileLayer.Grayscale(url, options);
};

L.GeoJSON.IndoorZone = L.GeoJSON.extend({
    initialize(feature, options) {
        const DEFAULT = {
            onEachFeature(feature, layer) {
                if (feature.properties.tags.length == 0) {
                    layer.bindPopup(
                        `Name: ${feature.properties.name}<br/>Tags: none`
                    );
                } else {
                    layer.bindPopup(
                        `Name: ${feature.properties.name}<br/>Tags: ${feature.properties.tags}`
                    );
                }
            },
            style(feature) {
                return {
                    fillColor: feature.properties.rgb_color || "#ffffff",
                    weight: 1,
                    color: "#ff7800",
                    fillOpacity: 0.4,
                };
            },
        };

        L.Util.setOptions(this, L.Util.extend(options || {}, DEFAULT));

        L.GeoJSON.prototype.initialize.call(this, feature, options);
        this._zoneId = feature.properties.id;
        this._zoneName = feature.properties.name;
        this._text = 0;

        const centroid = turf.centroid(feature);
        this._labelcenter = L.latLng(
            centroid.geometry.coordinates[1],
            centroid.geometry.coordinates[0]
        );

        const f = {
            type: "Feature",
            properties: {
                text: 0,
                labelPosition: [this._labelcenter.lng, this._labelcenter.lat],
            },
            geometry: {
                type: "Point",
                coordinates: [this._labelcenter.lng, this._labelcenter.lat],
            },
        };

        this._labeled_circle_marker = L.labeledCircleMarker(
            f.geometry.coordinates.slice().reverse(),
            f,
            {
                markerOptions: {
                    color: "#050",
                    radius: 15,
                },
            }
        );

        if (this.options.show_zone_counter === true) {
            L.GeoJSON.prototype.addLayer.call(this, this._labeled_circle_marker);
        }
    },

    getZoneId() {
        return this._zoneId;
    },

    getZoneName() {
        return this._zoneName;
    },

    updateLabelText(text) {
        if (
            this.options.show_zone_counter === true &&
            this._labeled_circle_marker._map !== null &&
            this._labeled_circle_marker._marker !== null &&
            this._labeled_circle_marker._marker._textElement !== null
        ) {
            this._text = +text;
            this._labeled_circle_marker.setText(this._text);
        }
    },

    getLabelText() {
        return this._text;
    },

    incrLabelText() {
        if (
            this.options.show_zone_counter === true &&
            this._labeled_circle_marker._map !== null &&
            this._labeled_circle_marker._marker !== null &&
            this._labeled_circle_marker._marker._textElement !== null
        ) {
            this._text += 1;
            this._labeled_circle_marker.setText(this._text);
        }
    },

    setDefaultFillColor() {
        this.updateFillColor("#ffffff");
    },

    contains(marker) {
        const geoJson = this.toGeoJSON();
        if (L.Util.isArray(geoJson["features"])) {
            const zone = geoJson["features"].filter(
                x => x.properties && x.properties.type === "map_zone"
            );
            if (zone.length && marker.lat && marker.lon) {
                const polygon = turf.polygon(zone[0].geometry.coordinates);
                const point = turf.point([marker.lon, marker.lat]);

                return turf.booleanPointInPolygon(point, polygon);
            }
        }

        return false;
    },

    updateFillColor(color) {
        this.eachLayer(layer => {
            if (layer.feature.properties.type === "map_zone") {
                layer.setStyle({
                    fillColor: color,
                    weight: 1,
                    color: "#ff7800",
                    fillOpacity: 0.4,
                });
            }
        });
    },
});

L.geoJson.indoor_zone = function(feature, options) {
    return new L.GeoJSON.IndoorZone(feature, options);
};

/**
 * leaflet indoor levels control
 */
L.LevelControl = L.Control.extend({
    includes: L.Evented.prototype,

    options: {
        position: "bottomright",

        // used to get a unique integer for each level to be used to order them
        parseLevel(level) {
            return parseInt(level, 10);
        },
    },

    initialize(options) {
        L.setOptions(this, options);

        this._buttons = {};
        this._level = this.options.level;
        this._levels = this.options.levels;
        this._levelMappings = this.options.levelMappings;

        this.on("levelchange", this._levelChange, this);
    },

    onAdd() {
        const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");

        div.style.font = "18px 'Lucida Console',Monaco,monospace";

        const buttons = this._buttons;
        const activeLevel = this._level;
        const self = this;

        const levels = [];

        for (let i = 0, l = this._levels.length; i < l; i += 1) {
            let level = this._levels[i];

            const levelNum = this.options.parseLevel(level);

            levels.push({
                num: levelNum,
                label: level,
            });
        }

        levels.sort((a, b) => (a.num > b.num ? 1 : -1));

        for (let i = levels.length - 1; i >= 0; i--) {
            let level = levels[i].num;
            const originalLevel = levels[i].label;
            const levelStr = this._levelMappings[level];

            let levelBtn = L.DomUtil.create("a", "leaflet-button-part", div);

            if (level === activeLevel || originalLevel === activeLevel) {
                levelBtn.style.backgroundColor = "#b0b0b0";
            }

            levelBtn.appendChild(
                levelBtn.ownerDocument.createTextNode(levelStr || originalLevel)
            )
            ;(function(level) {
                levelBtn.onclick = function() {
                    self.setLevel(level);
                };
            })(level);

            buttons[level] = levelBtn;
        }

        return div;
    },

    onRemove() {},

    _levelChange(e) {
        if (this._map !== null) {
            if (e.oldLevel != undefined) {
                this._buttons[e.oldLevel].style.backgroundColor = "#ffffff";
            }

            this._buttons[e.newLevel].style.backgroundColor = "#b0b0b0";
        }
    },

    setLevel(level) {
        if (level === this._level || !this._levels.includes(String(level))) {
            return;
        }

        const oldLevel = this._level;
        this._level = level;

        this.fireEvent("levelchange", {
            oldLevel,
            newLevel: level,
        });
    },

    getLevel() {
        return this._level;
    },
});

L.levelControl = function(options) {
    return new L.LevelControl(options);
};

L.BoundControl = L.Control.extend({
    includes: L.Evented.prototype,

    options: {
        position: "bottomleft",
    },

    initialize(options) {
        L.setOptions(this, options);
    },

    onAdd() {
        const self = this;

        const div = L.DomUtil.create(
            "div",
            "leaflet-bar leaflet-control leaflet-button-part"
        );

        this._boundBtn = L.DomUtil.create("a", "leaflet-button-part", div);
        this._boundIcon = L.DomUtil.create(
            "i",
            "mdi mdi-crosshairs-gps mdi-18px",
            this._boundBtn
        );

        L.DomEvent.on(div, "click", function() {
            self.fireEvent("click");
        });

        return div;
    },

    onRemove() {},
});

L.boundControl = function(options) {
    return new L.BoundControl(options);
};

L.LockControl = L.Control.extend({
    includes: L.Evented.prototype,

    options: {
        position: "bottomleft",
    },

    initialize(options) {
        L.setOptions(this, options);

        this._locked = false;
        this._lockBtn = null;
        this._lockIcon = null;

        this.on("lockchange", this._lockChange, this);
    },

    onAdd() {
        const self = this;

        const div = L.DomUtil.create(
            "div",
            "leaflet-bar leaflet-control leaflet-button-part"
        );

        this._lockBtn = L.DomUtil.create("a", "leaflet-button-part", div);
        this._lockIcon = L.DomUtil.create(
            "i",
            "mdi mdi-lock mdi-18px",
            this._lockBtn
        );

        L.DomEvent.on(div, "click", function() {
            self.fireEvent("lockchange");
        });

        return div;
    },

    _lockChange() {
        this._locked = !this._locked;

        if (L.DomUtil.hasClass(this._lockIcon, "mdi-lock")) {
            L.DomUtil.removeClass(this._lockIcon, "mdi-lock");
            L.DomUtil.addClass(this._lockIcon, "mdi-lock-open");
        } else if (L.DomUtil.hasClass(this._lockIcon, "mdi-lock-open")) {
            L.DomUtil.removeClass(this._lockIcon, "mdi-lock-open");
            L.DomUtil.addClass(this._lockIcon, "mdi-lock");
        }
    },

    onRemove() {},
});

L.lockControl = function(options) {
    return new L.LockControl(options);
};

/**
 * A layer that will display indoor data
 *
 * addData takes a GeoJSON feature collection, each feature must have a level
 * property that indicates the level.
 *
 * getLevels can be called to get the array of levels that are present.
 */

L.Indoor = L.Layer.extend({
    options: {
        // by default the levels are expected to be in the level attribute in
        // the feature properties, pass a replacement function in options if
        // this is not the case.
        getLevel(feature) {
            return feature.properties.level;
        },
    },

    initialize(data, options) {
        L.setOptions(this, options);

        const layers = (this._layers = {});

        this._bounds = {};
        this._zones = {};
        this._mapIds = {};
        this._mapUuids = {};
        this._levelMappings = {};

        this._levelControl = null;
        this._lockControl = null;
        this._zoneControl = null;
        this._boundControl = null;

        if ("level" in this.options) {
            this._level = String(this.options.level);
        } else {
            this._level = null;
        }

        if (
            "onSetLevel" in this.options &&
            isFunction(this.options["onSetLevel"])
        ) {
            this._onSetLevel = this.options.onSetLevel;
        } else {
            this._onSetLevel = function() {};
        }

        if (
            "onEachFeature" in this.options &&
            isFunction(this.options["onEachFeature"])
        ) {
            var onEachFeature = this.options.onEachFeature;
        }

        this.options.onEachFeature = function(feature, layer) {
            if (onEachFeature) {
                onEachFeature(feature, layer);
            }

            if (
                "markerForFeature" in this.options &&
                isFunction(this.options["markerForFeature"])
            ) {
                const marker = this.options["markerForFeature"](feature);

                if (marker instanceof L.Marker) {
                    marker.on("click", e => {
                        layer.fire("click", e);
                    });

                    const level = this.options.getLevel(feature);

                    if (L.Util.isArray(level)) {
                        level.forEach(addToLevel(marker, layers));
                    }

                    if (isLevel(level)) {
                        layers[level].addLayer(marker);
                    }
                }
            }
        };

        this.addData(data);
    },

    onAdd(map) {
        const self = this;

        if (!isLevel(this._level) || !(this._level in this._layers)) {
            const levels = this.getLevels();

            if (levels.length !== 0) {
                this._level = +levels[0];
            } else {
                return;
            }
        }

        if (this._zones[this._level]) {
            Object.values(this._zones[this._level]).forEach(layer =>
                layer.addTo(map)
            );

            this._zoneControl = L.control.layers(
                null,
                this._zones[this._level],
                {
                    collapsed: true,
                    position: "topright",
                }
            );
            this._zoneControl.addTo(map);
        }

        this._levelControl = L.levelControl({
            level: this._level,
            levels: this.getLevels(),
            levelMappings: this.getLevelMappings(),
        });
        this._levelControl.on("levelchange", this.setLevel, this);

        if (this.options["has_lock"] && this.options["has_lock"] === true) {
            this._lockControl = L.lockControl();
            this._lockControl.on("lockchange", function() {
                if (this._locked) {
                    map.dragging.disable();
                    map.touchZoom.disable();
                    map.doubleClickZoom.disable();
                    map.scrollWheelZoom.disable();

                    self.hideLevelZones();
                    self.hideZoneControl();
                } else {
                    map.dragging.enable();
                    map.touchZoom.enable();
                    map.doubleClickZoom.enable();
                    map.scrollWheelZoom.enable();

                    self.showLevelZones();
                    self.showZoneControl();
                }
            });

            this._lockControl.addTo(map);
        }

        if (
            this.options["has_bound_control"] &&
            this.options["has_bound_control"] === true
        ) {
            this._boundControl = L.boundControl();
            this._boundControl.on("click", function() {
                if (self._bounds[self._level]) {
                    map.fitBounds(self._bounds[self._level], {
                        padding: [20, 20],
                    });
                }
            });

            this._boundControl.addTo(map);
        }

        this._levelControl.addTo(map);
        this._layers[this._level].addTo(map);

        if (this._bounds[this._level]) {
            map.fitBounds(this._bounds[this._level], {
                padding: [20, 20],
            });
        }
    },

    onRemove(map) {
        if (
            this._level in this._layers &&
            map.hasLayer(this._layers[this._level])
        ) {
            map.removeLayer(this._layers[this._level]);
        }

        if (this._levelControl !== null) {
            map.removeControl(this._levelControl);
        }

        if (this._zoneControl !== null) {
            map.removeControl(this._zoneControl);
        }

        if (this._lockControl !== null) {
            map.removeControl(this._lockControl);
        }

        if (this._boundControl !== null) {
            map.removeControl(this._boundControl);
        }

        if (this._zones[this._level]) {
            Object.values(this._zones[this._level]).forEach(layerGroup => {
                if (map.hasLayer(layerGroup)) {
                    map.removeLayer(layerGroup);
                }
            });
        }
    },

    addData(data) {
        if (!L.Util.isArray(data)) {
            return;
        }

        let layers = this._layers,
            options = this.options,
            zones = this._zones,
            mapIds = this._mapIds,
            mapUuids = this._mapUuids,
            levelMappings = this._levelMappings;

        data.forEach(indoor_map => {
            const map_level = indoor_map.level;
            const map_uuid = indoor_map.uuid;
            const map_name = indoor_map.name;

            if (!isLevel(map_level)) {
                return;
            }

            let layer;
            if (map_level in layers) {
                layer = layers[map_level];
            } else {
                layer = layers[map_level] = L.geoJson(
                    {
                        type: "FeatureCollection",
                        features: [],
                    },
                    options
                );
            }

            if (
                map_level in levelMappings &&
                Array.isArray(levelMappings[map_level])
            ) {
                if (typeof map_name === "string" && map_name.length > 0) {
                    levelMappings[map_level].push(map_name);
                }
            } else {
                if (typeof map_name === "string" && map_name.length > 0) {
                    levelMappings[map_level] = [map_name];
                }
            }

            if (!(map_level in mapIds)) {
                mapIds[map_level] = [indoor_map.id];
            } else if (Array.isArray(mapIds[map_level])) {
                mapIds[map_level].push(indoor_map.id);
            }

            if (!(map_level in mapUuids)) {
                mapUuids[map_level] = [indoor_map.uuid];
            } else if (Array.isArray(mapUuids[map_level])) {
                mapUuids[map_level].push(indoor_map.uuid);
            }

            // Tiles Layer
            if (!isEmpty(indoor_map["tiles_url_base"])) {
                if (!options.grayscale) {
                    L.tileLayer(indoor_map["tiles_url_base"], {
                        tms: true,
                        maxZoom: 23,
                        bounds: indoor_map["map_bounds"] || [],
                    }).addTo(layer);
                } else {
                    L.tileLayer
                        .grayscale(indoor_map["tiles_url_base"], {
                            tms: true,
                            maxZoom: 23,
                            bounds: indoor_map["map_bounds"] || [],
                            fadeAnimation: false,
                        })
                        .addTo(layer);
                }

                if (indoor_map["map_bounds"]) {
                    this._bounds[map_uuid] = L.latLngBounds(
                        indoor_map["map_bounds"]
                    );

                    if (!this._bounds[map_level]) {
                        this._bounds[map_level] = L.latLngBounds(
                            indoor_map["map_bounds"]
                        );
                    } else {
                        this._bounds[map_level] = this._bounds[
                            map_level
                        ].extend(L.latLngBounds(indoor_map["map_bounds"]));
                    }
                }
            }

            // Features
            // To hide
            if (
                !isObject(indoor_map["map_features"]) ||
                !L.Util.isArray(indoor_map["map_features"]["features"]) ||
                options.hide_zones === true
            ) {
                return;
            }

            const features = indoor_map["map_features"]["features"];
            features.forEach(feature => {
                const level = options.getLevel(feature);

                // No Level, so we don't know where to add them
                // Ignore them then
                if (isEmpty(level)) {
                    return;
                }

                // Invalid Feature
                if (!("geometry" in feature)) {
                    return;
                }

                // Hide this feature if `hide_on_level` is set to true
                if (
                    feature.properties &&
                    feature.properties.hide_on_level === true
                ) {
                    return;
                }

                const splitFeatureIntoLevel = level => {
                    if (
                        feature.geometry.type === "Polygon" &&
                        feature.properties.type === "map_zone"
                    ) {
                        let indoor_zone_layer = L.geoJson.indoor_zone(feature, {
                            show_zone_counter: this.options.show_zone_counter,
                        });

                        if (level in zones) {
                            const level_zone = zones[level];

                            if (
                                L.Util.isArray(feature.properties.tags) &&
                                feature.properties.tags.length
                            ) {
                                Array.from(
                                    new Set(feature.properties.tags)
                                ).forEach(tag => {
                                    const name = `Zone - Tags: ${tag || "none"}`;

                                    if (name in level_zone) {
                                        level_zone[name].addLayer(
                                            indoor_zone_layer
                                        );
                                    } else {
                                        level_zone[
                                            name
                                        ] = L.layerGroup().addLayer(
                                            indoor_zone_layer
                                        );
                                    }
                                });
                            } else {
                                const name = "Zone - Tags: none";

                                if (name in level_zone) {
                                    level_zone[name].addLayer(indoor_zone_layer);
                                } else {
                                    level_zone[name] = L.layerGroup().addLayer(
                                        indoor_zone_layer
                                    );
                                }
                            }
                        } else {
                            if (
                                L.Util.isArray(feature.properties.tags) &&
                                feature.properties.tags.length
                            ) {
                                zones[level] = {};

                                Array.from(
                                    new Set(feature.properties.tags)
                                ).forEach(tag => {
                                    const name = `Zone - Tags: ${tag || "none"}`;

                                    zones[level][
                                        name
                                    ] = L.layerGroup().addLayer(
                                        indoor_zone_layer
                                    );
                                });
                            } else {
                                const name = "Zone - Tags: none";

                                zones[level] = {
                                    [name]: L.layerGroup().addLayer(
                                        indoor_zone_layer
                                    ),
                                };
                            }
                        }
                    } else {
                        if (level in layers) {
                            layer.addData(feature);
                        } else {
                            layers[level] = L.geoJson(
                                {
                                    type: "FeatureCollection",
                                    features: [],
                                },
                                options
                            );

                            layers[level].addData(feature);
                        }
                    }
                };

                // if the feature is on multiple levels
                if (L.Util.isArray(level)) {
                    level.forEach(l => {
                        splitFeatureIntoLevel(l);
                    });
                } else {
                    splitFeatureIntoLevel(level);
                }
            });
        });

        if (this._map != null && this._levelControl != null) {
            this._map.removeControl(this._levelControl);
        }

        this._levelControl = L.levelControl({
            level: this._level,
            levels: this.getLevels(),
        });

        this._levelControl.on("levelchange", this.setLevel, this);

        if (this._map != null) {
            this._levelControl.addTo(this._map);
        }
    },

    getLevels() {
        return Object.keys(this._layers);
    },

    getLevelMappings() {
        return Object.keys(this._levelMappings).reduce((ite, cur) => {
            if (
                Array.isArray(this._levelMappings[cur]) &&
                this._levelMappings[cur].length === 1
            ) {
                if (this._levelMappings[cur][0].indexOf("|") > 0) {
                    let parts = this._levelMappings[cur][0]
                        .split("|")
                        .map(x => x.trim())
                        .filter(x => x.length > 0);

                    if (parts.length >= 2) {
                        ite[cur] = parts[1];
                    }
                }
            } else if (
                Array.isArray(this._levelMappings[cur]) &&
                this._levelMappings[cur].length > 1
            ) {
                const parts = this._levelMappings[cur]
                    .filter(x => x.indexOf("|") > 0)
                    .map(x => x.split("|").map(x => x.trim()))
                    .filter(
                        x => x.length >= 2 && x[0].length > 0 && x[1].length > 0
                    )
                    .map(x => x[1]);

                if (parts.length === this._levelMappings[cur].length) {
                    ite[cur] = parts[0];
                }
            }
            return ite;
        }, {});
    },

    getLevel() {
        return this._level;
    },

    getLevelCenter() {
        if (this._bounds[this._level]) {
            return this._bounds[this._level].getCenter();
        }

        return null;
    },

    getLevelCenters() {
        if (
            Array.isArray(this._mapUuids[this._level]) &&
            this._mapUuids[this._level].length > 0
        ) {
            return this._mapUuids[this._level].reduce((ite, cur) => {
                const center = this.getMapCenter(cur);
                if (center !== null) {
                    ite[cur] = center;
                }
                return ite;
            }, {});
        }

        return null;
    },

    getMapCenter(map_uuid) {
        if (map_uuid != undefined && this._bounds[map_uuid]) {
            return this._bounds[map_uuid].getCenter();
        }

        return null;
    },

    getLevelMapIds() {
        if (this._mapIds[this._level]) {
            return this._mapIds[this._level];
        }

        return null;
    },

    getLevelMapUuids(level) {
        const _level = level || this._level;
        if (this._mapUuids[_level]) {
            return this._mapUuids[_level];
        }

        return null;
    },

    getLevelZones(level) {
        const _level = level || this._level;
        if (this._zones[_level]) {
            return Object.values(this._zones[_level]).reduce((ite, cur) => {
                cur.eachLayer(layer => ite.push(layer));
                return ite;
            }, []);
        }

        return [];
    },

    getZones() {
        return Object.keys(this._zones).reduce((ite, cur) => {
            const zones = this.getLevelZones(cur);
            ite[cur] = zones;

            zones.forEach(zone => {
                ite[zone.getZoneId()] = zone;
            });

            return ite;
        }, {});
    },

    hideLevelZones() {
        if (
            this._map !== null &&
            this._zones !== null &&
            this._zones[this._level]
        ) {
            Object.values(this._zones[this._level]).forEach(layer => {
                if (this._map.hasLayer(layer)) {
                    this._map.removeLayer(layer);
                }
            });
        }
    },

    showLevelZones() {
        if (
            this._map !== null &&
            this._zones !== null &&
            this._zones[this._level]
        ) {
            Object.values(this._zones[this._level]).forEach(layer => {
                if (!this._map.hasLayer(layer)) {
                    this._map.addLayer(layer);
                }
            });
        }
    },

    hideZoneControl() {
        if (
            this._map !== null &&
            this._zoneControl !== null &&
            this._zoneControl._map !== null
        ) {
            this._map.removeControl(this._zoneControl);
        }
    },

    showZoneControl() {
        if (
            this._map !== null &&
            this._zoneControl !== null &&
            !this._zoneControl._map
        ) {
            this._zoneControl.addTo(this._map);
        }
    },

    setLevel(level) {
        if (isObject(level)) level = level.newLevel;

        if (
            !isLevel(level) ||
            this._level === level ||
            !(level in this._layers)
        ) {
            return;
        }

        this._levelControl.setLevel(level);

        const oldLayer = this._layers[this._level];
        const layer = this._layers[level];
        const event = {
            oldLevel: this._level,
            newLevel: level,
        };

        if (this._map !== null) {
            if (this._map.hasLayer(oldLayer)) {
                this._map.removeLayer(oldLayer);
            }

            if (!this._map.hasLayer(layer)) {
                this._map.addLayer(layer);
            }

            if (this._bounds[level]) {
                this._map.fitBounds(this._bounds[level], {
                    padding: [20, 20],
                });
            }

            if (this._zoneControl !== null) {
                this._map.removeControl(this._zoneControl);
            }

            if (this._zones[this._level]) {
                Object.values(this._zones[this._level]).forEach(layer => {
                    if (this._map.hasLayer(layer)) {
                        this._map.removeLayer(layer);
                    }
                });

                if (
                    this._zoneControl !== null &&
                    this._zoneControl._map !== null
                ) {
                    this._map.removeControl(this._zoneControl);
                }

                this._zoneControl = null;
            }

            if (this._zones[level]) {
                Object.values(this._zones[level]).forEach(layer =>
                    layer.addTo(this._map)
                );

                this._zoneControl = L.control.layers(null, this._zones[level], {
                    collapsed: true,
                    position: "topright",
                });
                this._zoneControl.addTo(this._map);
            }

            this._level = level;

            this._onSetLevel.call(this, event);
        }
    },
});

L.indoor = function(data, options) {
    return new L.Indoor(data, options);
};

function addToLevel(marker, layers) {
    return function(level) {
        if (!isLevel(level)) return;
        layers[level].addLayer(marker);
    };
}
