import L from 'leaflet';

import './Util';
import './Matrix';

/**
 * Marker handler
 * @extends {L.CircleMarker}
 */
L.PathTransform.Handle = L.CircleMarker.extend({
    options: {
        className: 'leaflet-path-transform-handler',
    },

    onAdd(map) {
        L.CircleMarker.prototype.onAdd.call(this, map);
        if (this._path && this.options.setCursor) { // SVG/VML
            this._path.style.cursor = L.PathTransform.Handle.CursorsByType[
                this.options.index
            ];
        }
    },
});


/**
 * @const
 * @type {Array}
 */
L.PathTransform.Handle.CursorsByType = [
    'nesw-resize', 'nwse-resize', 'nesw-resize', 'nwse-resize',
];


/**
 * @extends {L.Handler.PathTransform.Handle}
 */
L.PathTransform.RotateHandle = L.PathTransform.Handle.extend({
    options: {
        className: 'leaflet-path-transform-handler transform-handler--rotate',
    },

    onAdd(map) {
        L.CircleMarker.prototype.onAdd.call(this, map);
        if (this._path && this.options.setCursor) { // SVG/VML
            this._path.style.cursor = 'all-scroll';
        }
    },
});

L.Handler.PathTransform = L.Handler.extend({

    options: {
        rotation: true,
        scaling:  true,
        uniformScaling: true,
        maxZoom:  22,

        // edge handlers
        handlerOptions: {
            radius:      12,
            fillColor:   '#ffffff',
            color:       '#202020',
            fillOpacity: 1,
            weight:      2,
            opacity:     0.7,
            setCursor:   true,
        },

        // rectangle
        boundsOptions: {
            weight:    1,
            opacity:   1,
            dashArray: [3, 3],
            fill:      false,
            noClip:    true,
        },

        // rotation handler
        rotateHandleOptions: {
            weight:    1,
            opacity:   1,
            setCursor: true,
        },
        // rotation handle length
        handleLength: 40,

        // maybe I'll add skewing in the future
        edgesCount:   4,

        handleClass:       L.PathTransform.Handle,
        rotateHandleClass: L.PathTransform.RotateHandle,
    },


    /**
     * @class L.Handler.PathTransform
     * @constructor
     * @param  {L.Path} path
     */
    initialize(path) {
    // references
        this._path = path;
        this._map  = null;

        // handlers
        this._activeMarker   = null;
        this._originMarker   = null;
        this._rotationMarker = null;

        // origins & temporary state
        this._rotationOrigin   = null;
        this._scaleOrigin      = null;
        this._angle            = 0;
        this._scale            = L.point(1, 1);
        this._initialDist      = 0;
        this._initialDistX     = 0;
        this._initialDistY     = 0;
        this._rotationStart    = null;
        this._rotationOriginPt = null;

        // preview and transform matrix
        this._matrix          = new L.Matrix(1, 0, 0, 1, 0, 0);
        this._projectedMatrix = new L.Matrix(1, 0, 0, 1, 0, 0);

        // ui elements
        this._handlersGroup  = null;
        this._rect           = null;
        this._handlers       = [];
        this._handleLine     = null;
    },


    /**
     * If the polygon is not rendered, you can transform it yourself
     * in the coordinates, and do it properly.
     * @param {Object=} options
     */
    enable(options) {
        if (this._path._map) {
            this._map = this._path._map;
            if (options) {
                this.setOptions(options);
            }
            L.Handler.prototype.enable.call(this);
        }
    },


    /**
     * Init interactions and handlers
     */
    addHooks() {
        this._createHandlers();
        this._path
            .on('dragstart', this._onDragStart, this)
            .on('dragend',   this._onDragEnd,   this);
    },


    /**
     * Remove handlers
     */
    removeHooks() {
        this._hideHandlers();
        this._path
            .off('dragstart', this._onDragStart, this)
            .off('dragend',   this._onDragEnd,   this);
        this._handlersGroup = null;
        this._rect = null;
        this._handlers = [];
    },


    /**
     * Change editing options
     * @param {Object} options
     */
    setOptions(options) {
        const enabled = this._enabled;
        if (enabled) {
            this.disable();
        }

        this.options = L.PathTransform.merge({}, L.Handler.PathTransform.prototype.options, options);

        if (enabled) {
            this.enable();
        }

        return this;
    },


    /**
     * @param  {Number}   angle
     * @param  {L.LatLng} origin
     * @return {L.Handler.PathTransform}
     */
    rotate(angle, origin) {
        return this.transform(angle, null, origin);
    },


    /**
     * @param  {L.Point|Number} scale
     * @param  {L.LatLng}       origin
     * @return {L.Handler.PathTransform}
     */
    scale(scale, origin) {
        if (typeof scale === 'number') {
            scale = L.point(scale, scale);
        }
        return this.transform(0, scale, null, origin);
    },


    /**
     * @param  {Number}    angle
     * @param  {L.Point}   scale
     * @param  {L.LatLng=} rotationOrigin
     * @param  {L.LatLng=} scaleOrigin
     * @return {L.Handler.PathTransform}
     */
    transform(angle, scale, rotationOrigin, scaleOrigin) {
        const center     = this._path.getCenter();
        rotationOrigin = rotationOrigin || center;
        scaleOrigin    = scaleOrigin    || center;
        this._map = this._path._map;
        this._transformPoints(this._path, angle, scale, rotationOrigin, scaleOrigin);
        this._transformPoints(this._rect, angle, scale, rotationOrigin, scaleOrigin);

        if (this._handleLine !== null) {
            this._handleLine.eachLayer((layer) => {
                this._transformPoints(layer, angle, scale, rotationOrigin, scaleOrigin);
            });
        }
        this._updateHandlers();
        return this;
    },


    /**
     * Update the polygon and handlers preview, no reprojection
     */
    _update() {
        let matrix = this._matrix;

        // update handlers
        for (let i = 0, len = this._handlers.length; i < len; i++) {
            const handler = this._handlers[i];
            if (handler !== this._originMarker) {
                handler._point = matrix.transform(handler._initialPoint);
                handler._updatePath();
            }
        }

        matrix = matrix.clone().flip();

        this._applyTransform(matrix);
        this._path.fire('transform', { layer: this._path });
    },


    /**
     * @param  {L.Matrix} matrix
     */
    _applyTransform(matrix) {
        this._path._transform(matrix._matrix);
        this._rect._transform(matrix._matrix);

        if (this.options.rotation && this._handleLine !== null) {
            this._handleLine.eachLayer((layer) => {
                layer._transform(matrix._matrix);
            });
        }
    },


    /**
     * Apply final transformation
     */
    _apply() {
    // console.group('apply transform');
        const map = this._map;
        const matrix = this._matrix.clone();
        const angle = this._angle;
        const scale = this._scale.clone();

        this._transformGeometries();

        // update handlers
        for (let i = 0, len = this._handlers.length; i < len; i++) {
            const handler = this._handlers[i];
            handler._latlng = map.layerPointToLatLng(handler._point);
            delete handler._initialPoint;
            handler.redraw();
        }

        this._matrix = L.matrix(1, 0, 0, 1, 0, 0);
        this._scale  = L.point(1, 1);
        this._angle  = 0;

        this._updateHandlers();

        map.dragging.enable();
        this._path.fire('transformed', {
            matrix,
            scale,
            rotation: angle,
            // angle: angle * (180 / Math.PI),
            layer: this._path,
        });
    // console.groupEnd('apply transform');
    },


    /**
     * Use this method to completely reset handlers, if you have changed the
     * geometry of transformed layer
     */
    reset() {
        if (this._enabled) {
            if (this._rect) {
                this._handlersGroup.removeLayer(this._rect);
                this._rect = this._getBoundingPolygon().addTo(this._handlersGroup);
            }
            this._updateHandlers();
        }
    },


    /**
     * Recalculate rotation handlers position
     */
    _updateHandlers() {
        const handlersGroup = this._handlersGroup;

        this._rectShape = this._rect.toGeoJSON();

        if (this._handleLine) {
            this._handleLine.eachLayer((layer) => {
                this._handlersGroup.removeLayer(layer);
                this._handleLine.removeLayer(layer);
            });
        }

        if (this._rotationMarker) {
            this._rotationMarker.eachLayer((layer) => {
                this._handlersGroup.removeLayer(layer);
                this._rotationMarker.removeLayer(layer);
            });
        }

        this._handleLine = this._rotationMarker = null;

        for (let i = this._handlers.length - 1; i >= 0; i--) {
            handlersGroup.removeLayer(this._handlers[i]);
        }

        this._createHandlers();
    },


    /**
     * Transform geometries separately
     */
    _transformGeometries() {
        this._path._transform(null);
        this._rect._transform(null);

        this._transformPoints(this._path);
        this._transformPoints(this._rect);

        if (this.options.rotation && this._handleLine !== null) {
            this._handleLine.eachLayer((layer) => {
                layer._transform(null);
                this._transformPoints(layer, this._angle, null, this._origin);
            });
        }
    },


    /**
     * @param {Number} angle
     * @param {Number} scale
     * @param {L.LatLng=} rotationOrigin
     * @param {L.LatLng=} scaleOrigin
     */
    _getProjectedMatrix(angle, scale, rotationOrigin, scaleOrigin) {
        const map    = this._map;
        const zoom   = map.getMaxZoom() || this.options.maxZoom;
        let matrix = L.matrix(1, 0, 0, 1, 0, 0);
        let origin;

        angle = angle || this._angle || 0;
        scale = scale || this._scale || L.point(1, 1);

        if (!(scale.x === 1 && scale.y === 1)) {
            scaleOrigin = scaleOrigin || this._scaleOrigin;
            origin = map.project(scaleOrigin, zoom);
            matrix = matrix
                ._add(L.matrix(1, 0, 0, 1, origin.x, origin.y))
                ._add(L.matrix(scale.x, 0, 0, scale.y, 0, 0))
                ._add(L.matrix(1, 0, 0, 1, -origin.x, -origin.y));
        }

        if (angle) {
            rotationOrigin = rotationOrigin || this._rotationOrigin;
            origin = map.project(rotationOrigin, zoom);
            matrix = matrix.rotate(angle, origin).flip();
        }

        return matrix;
    },


    /**
     * @param  {L.LatLng} latlng
     * @param  {L.Matrix} matrix
     * @param  {L.Map}    map
     * @param  {Number}   zoom
     * @return {L.LatLng}
     */
    _transformPoint(latlng, matrix, map, zoom) {
        return map.unproject(matrix.transform(
            map.project(latlng, zoom),
        ), zoom);
    },


    /**
     * Applies transformation, does it in one sweep for performance,
     * so don't be surprised about the code repetition.
     *
     * @param {L.Path}    path
     * @param {Number=}   angle
     * @param {L.Point=}  scale
     * @param {L.LatLng=} rotationOrigin
     * @param {L.LatLng=} scaleOrigin
     */
    _transformPoints(path, angle, scale, rotationOrigin, scaleOrigin) {
        const map = path._map;
        const zoom = map.getMaxZoom() || this.options.maxZoom;
        let i; let
            len;

        const projectedMatrix = this._projectedMatrix =            this._getProjectedMatrix(angle, scale, rotationOrigin, scaleOrigin);
        // console.time('transform');

        // all shifts are in-place
        if (path._point) { // L.Circle
            path._latlng = this._transformPoint(path._latlng, projectedMatrix, map, zoom);
        } else if (path._rings || path._parts) { // everything else
            const rings = path._rings;
            let latlngs = path._latlngs;
            path._bounds = new L.LatLngBounds();

            if (!L.Util.isArray(latlngs[0])) { // polyline
                latlngs = [latlngs];
            }
            for (i = 0, len = rings.length; i < len; i++) {
                for (let j = 0, jj = rings[i].length; j < jj; j++) {
                    latlngs[i][j] = this._transformPoint(
                        latlngs[i][j], projectedMatrix, map, zoom,
                    );
                    path._bounds.extend(latlngs[i][j]);
                }
            }
        }

        path._reset();
    // console.timeEnd('transform');
    },


    /**
     * Creates markers and handles
     */
    _createHandlers() {
        const map = this._map;
        this._handlersGroup = this._handlersGroup
            || new L.LayerGroup().addTo(map);
        this._rect = this._rect
            || this._getBoundingPolygon().addTo(this._handlersGroup);

        if (this.options.scaling) {
            this._handlers = [];
            for (let i = 0; i < this.options.edgesCount; i++) {
                // TODO: add stretching
                this._handlers.push(
                    this._createHandler(this._rect._latlngs[0][i], i * 2, i)
                        .addTo(this._handlersGroup),
                );
            }
        }

        // add bounds
        if (this.options.rotation) {
            // add rotation handler
            this._createRotationHandlers();
        }
    },


    /**
     * Rotation marker and small connectin handle
     */
    _createRotationHandlers() {
        const map     = this._map;
        const latlngs = this._rect._latlngs[0];

        const bottom   = new L.LatLng(
            (latlngs[0].lat + latlngs[3].lat) / 2,
            (latlngs[0].lng + latlngs[3].lng) / 2,
        );

        const left = new L.LatLng(
            (latlngs[0].lat + latlngs[1].lat) / 2,
            (latlngs[0].lng + latlngs[1].lng) / 2,
        );

        const right = new L.LatLng(
            (latlngs[2].lat + latlngs[3].lat) / 2,
            (latlngs[2].lng + latlngs[3].lng) / 2,
        );

        // hehe, top is a reserved word
        const topPoint = new L.LatLng(
            (latlngs[1].lat + latlngs[2].lat) / 2,
            (latlngs[1].lng + latlngs[2].lng) / 2,
        );

        const handlerPositionTopPoint = map.layerPointToLatLng(
            L.PathTransform.pointOnLine(
                map.latLngToLayerPoint(bottom),
                map.latLngToLayerPoint(topPoint),
                this.options.handleLength,
            ),
        );

        const handlerPositionBottomPoint = map.layerPointToLatLng(
            L.PathTransform.pointOnLine(
                map.latLngToLayerPoint(topPoint),
                map.latLngToLayerPoint(bottom),
                this.options.handleLength,
            ),
        );

        const handlerPositionLeftPoint = map.layerPointToLatLng(
            L.PathTransform.pointOnLine(
                map.latLngToLayerPoint(right),
                map.latLngToLayerPoint(left),
                this.options.handleLength,
            ),
        );

        const handlerPositionRightPoint = map.layerPointToLatLng(
            L.PathTransform.pointOnLine(
                map.latLngToLayerPoint(left),
                map.latLngToLayerPoint(right),
                this.options.handleLength,
            ),
        );

        this._handleLine = L.layerGroup();
        this._rotationMarker = L.layerGroup();

        const RotateHandleClass = this.options.rotateHandleClass;

        const handleLineTop = new L.Polyline([topPoint, handlerPositionTopPoint], this.options.rotateHandleOptions)
            .addTo(this._handlersGroup);
        const handleLineBottom = new L.Polyline([bottom, handlerPositionBottomPoint], this.options.rotateHandleOptions)
            .addTo(this._handlersGroup);
        const handleLineLeft = new L.Polyline([left, handlerPositionLeftPoint], this.options.rotateHandleOptions)
            .addTo(this._handlersGroup);
        const handleLineRight = new L.Polyline([right, handlerPositionRightPoint], this.options.rotateHandleOptions)
            .addTo(this._handlersGroup);

        this._handleLine.addLayer(handleLineTop);
        this._handleLine.addLayer(handleLineBottom);
        this._handleLine.addLayer(handleLineLeft);
        this._handleLine.addLayer(handleLineRight);

        const rotationMarkerTop = new RotateHandleClass(handlerPositionTopPoint, this.options.handlerOptions)
            .addTo(this._handlersGroup).on('mousedown', this._onRotateStart, this);
        const rotationMarkerBottom = new RotateHandleClass(handlerPositionBottomPoint, this.options.handlerOptions)
            .addTo(this._handlersGroup).on('mousedown', this._onRotateStart, this);
        const rotationMarkerLeft = new RotateHandleClass(handlerPositionLeftPoint, this.options.handlerOptions)
            .addTo(this._handlersGroup).on('mousedown', this._onRotateStart, this);
        const rotationMarkerRight = new RotateHandleClass(handlerPositionRightPoint, this.options.handlerOptions)
            .addTo(this._handlersGroup).on('mousedown', this._onRotateStart, this);

        this._rotationMarker.addLayer(rotationMarkerTop);
        this._rotationMarker.addLayer(rotationMarkerBottom);
        this._rotationMarker.addLayer(rotationMarkerLeft);
        this._rotationMarker.addLayer(rotationMarkerRight);

        this._rotationOrigin = new L.LatLng(
            (topPoint.lat + bottom.lat) / 2,
            (topPoint.lng + bottom.lng) / 2,
        );

        this._rotationMarker.eachLayer((marker) => {
            this._handlers.push(marker);
        });
    },


    /**
     * @return {L.LatLng}
     */
    _getRotationOrigin() {
        const latlngs = this._rect._latlngs[0];
        const lb = latlngs[0];
        const rt = latlngs[2];

        return new L.LatLng(
            (lb.lat + rt.lat) / 2,
            (lb.lng + rt.lng) / 2,
        );
    },


    /**
     * Secure the rotation origin
     * @param  {Event} evt
     */
    _onRotateStart(evt) {
        const map = this._map;

        map.dragging.disable();

        this._originMarker     = null;
        this._rotationOriginPt = map.latLngToLayerPoint(this._getRotationOrigin());
        this._rotationStart    = evt.layerPoint;
        this._initialMatrix    = this._matrix.clone();

        this._angle = 0;
        this._path._map
            .on('mousemove', this._onRotate,     this)
            .on('mouseup',   this._onRotateEnd, this);

        this._cachePoints();
        this._path
            .fire('transformstart',   { layer: this._path })
            .fire('rotatestart', { layer: this._path, rotation: 0 });
    },


    /**
     * @param  {Event} evt
     */
    _onRotate(evt) {
        const pos = evt.layerPoint;
        const previous = this._rotationStart;
        const origin   = this._rotationOriginPt;

        // rotation step angle
        this._angle = Math.atan2(pos.y - origin.y, pos.x - origin.x)
            - Math.atan2(previous.y - origin.y, previous.x - origin.x);

        this._matrix = this._initialMatrix
            .clone()
            .rotate(this._angle, origin)
            .flip();
        this._update();
        this._path.fire('rotate', { layer: this._path, rotation: this._angle });
    },


    /**
     * @param  {Event} evt
     */
    _onRotateEnd(evt) {
        this._path._map
            .off('mousemove', this._onRotate, this)
            .off('mouseup',   this._onRotateEnd, this);

        const angle = this._angle;
        this._apply();
        this._path.fire('rotateend', { layer: this._path, rotation: angle });
    },


    /**
     * @param  {Event} evt
     */
    _onScaleStart(evt) {
        const marker = evt.target;
        const map = this._map;

        map.dragging.disable();

        this._activeMarker = marker;

        this._originMarker = this._handlers[(marker.options.index + 2) % 4];
        this._scaleOrigin  = this._originMarker.getLatLng();

        this._initialMatrix = this._matrix.clone();
        this._cachePoints();

        this._map
            .on('mousemove', this._onScale,    this)
            .on('mouseup',   this._onScaleEnd, this);
        this._initialDist  = this._originMarker._point.distanceTo(this._activeMarker._point);
        this._initialDistX = this._originMarker._point.x - this._activeMarker._point.x;
        this._initialDistY = this._originMarker._point.y - this._activeMarker._point.y;

        this._path
            .fire('transformstart', { layer: this._path })
            .fire('scalestart', { layer: this._path, scale: L.point(1, 1) });

        if (this._handleLine) {
            this._handleLine.eachLayer((layer) => {
                this._handlersGroup.removeLayer(layer);
                this._handleLine.removeLayer(layer);
            });
        }

        if (this._rotationMarker) {
            this._rotationMarker.eachLayer((layer) => {
                this._handlersGroup.removeLayer(layer);
                this._rotationMarker.removeLayer(layer);
            });
        }

    // this._handleLine = this._rotationMarker = null;
    },


    /**
     * @param  {Event} evt
     */
    _onScale(evt) {
        const originPoint = this._originMarker._point;
        let ratioX; let
            ratioY;
        if (this.options.uniformScaling) {
            ratioX = originPoint.distanceTo(evt.layerPoint) / this._initialDist;
            ratioY = ratioX;
        } else {
            ratioX = (originPoint.x - evt.layerPoint.x) / this._initialDistX;
            ratioY = (originPoint.y - evt.layerPoint.y) / this._initialDistY;
        }

        this._scale = new L.Point(ratioX, ratioY);

        // update matrix
        this._matrix = this._initialMatrix
            .clone()
            .scale(this._scale, originPoint);

        this._update();
        this._path.fire('scale', { layer: this._path, scale: this._scale.clone() });
    },


    /**
     * Scaling complete
     * @param  {Event} evt
     */
    _onScaleEnd(evt) {
        this._map
            .off('mousemove', this._onScale,    this)
            .off('mouseup',   this._onScaleEnd, this);

        if (this._handleLine) {
            this._map.addLayer(this._handleLine);
        }
        if (this._rotationMarker) {
            this._map.addLayer(this._rotationMarker);
        }

        this._apply();
        this._path.fire('scaleend', { layer: this._path, scale: this._scale.clone() });
    },


    /**
     * Cache current handlers positions
     */
    _cachePoints() {
        this._handlersGroup.eachLayer((layer) => {
            layer.bringToFront();
        });
        for (let i = 0, len = this._handlers.length; i < len; i++) {
            const handler = this._handlers[i];
            handler._initialPoint = handler._point.clone();
        }
    },


    /**
     * Bounding polygon
     * @return {L.Polygon}
     */
    _getBoundingPolygon() {
        if (this._rectShape) {
            return L.GeoJSON.geometryToLayer(
                this._rectShape, this.options.boundsOptions,
            );
        }
        return new L.Rectangle(
            this._path.getBounds(), this.options.boundsOptions,
        );
    },


    /**
     * Create corner marker
     * @param  {L.LatLng} latlng
     * @param  {Number}   type one of L.Handler.PathTransform.HandlerTypes
     * @param  {Number}   index
     * @return {L.Handler.PathTransform.Handle}
     */
    _createHandler(latlng, type, index) {
        const HandleClass = this.options.handleClass;
        const marker = new HandleClass(latlng,
            L.Util.extend({}, this.options.handlerOptions, {
                className: `leaflet-drag-transform-marker drag-marker--${
                    index} drag-marker--${type}`,
                index,
                type,
            }));

        marker.on('mousedown', this._onScaleStart, this);
        return marker;
    },


    /**
     * Hide(not remove) the handlers layer
     */
    _hideHandlers() {
        this._map.removeLayer(this._handlersGroup);
    },


    /**
     * Hide handlers and rectangle
     */
    _onDragStart() {
        this._hideHandlers();
    },


    /**
     * Drag rectangle, re-create handlers
     */
    _onDragEnd(evt) {
        const rect = this._rect;
        const matrix = (evt.layer ? evt.layer : this._path).dragging._matrix.slice();

        if (!rect.dragging) {
            rect.dragging = new L.Handler.PathDrag(rect);
        }
        rect.dragging.enable();
        this._map.addLayer(rect);
        rect.dragging._transformPoints(matrix);
        rect._updatePath();
        rect._project();
        rect.dragging.disable();

        this._map.addLayer(this._handlersGroup);
        this._updateHandlers();

        this._path.fire('transformed', {
            scale: L.point(1, 1),
            rotation: 0,
            matrix: L.matrix.apply(undefined, matrix),
            translate: L.point(matrix[4], matrix[5]),
            layer: this._path,
        });
    },
});


L.Path.addInitHook(function () {
    if (this.options.transform) {
        this.transform = new L.Handler.PathTransform(this, this.options.transform);
    }
});
