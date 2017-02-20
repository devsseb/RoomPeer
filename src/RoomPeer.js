/** 
 * RoomPeer v1.0.0
 * Use Webrtc to create peer connections
 * https://github.com/devsseb/RoomPeer
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

var RoomPeer = function(options)
{

	// https://www.webrtc-experiment.com/docs/webrtc-for-beginners.html
	// https://github.com/webrtc/samples/blob/gh-pages/src/content/datachannel/basic/js/main.js
	if (window.RTCPeerConnection == undefined)
			window.RTCPeerConnection = (window.webkitRTCPeerConnection || window.mozRTCPeerConnection);

	if (window.RTCPeerConnection == undefined) {
		this.log('This browser does not support RTCPeerConnection', 1);
		return;
	}

	this.debug = options.debug;
	this.name = options.name || 'Nameless';
	this.server = {
		url: options.server || 'roompeer.php',
		user: options.user || null,
		password: options.password || null
	}
	this.key = null;
	this.peers = {};
	this.peersLength = 0;
	this.checkUpdateTimeout = null;
	this.onicecandidateTimeout = {};
	this.inExit = false;
	this.events = {
		ready: [],
		create: [],
		enter: [],
		guest: [],
		guestExit: [],
		full: [],
		exit: [],
		message : [],
		error: [],
		event: []
	};
	for (name in this.events)
		if (options['on' + name])
			this.on(name, options['on' + name]);

	setTimeout(function() {
		this.log('Ready');
		this.trigger('ready');
	}.bind(this));
}

RoomPeer.prototype.log = function(message, errorId)
{
	if (this.debug) {
		if (errorId) {
			console.error('[RoomPeer' + (this.name ? ' "' + this.name + '"' : '') + ' error ' + errorId + '] ' + message);
			this.trigger('error', message, errorId);
		}
		else
			console.log('[RoomPeer' + (this.name ? ' "' + this.name + '"' : '') + '] ' + message);	
	}

}

RoomPeer.prototype.serverSend = function(data, callback)
{
	data.key = this.key;
	data.id = this.id;

	var params = '';
	for (var key in data)
		params+= (params.length ? '&' : '') + key + '=' + encodeURIComponent(data[key]);

	var xhr = new XMLHttpRequest();
	xhr.open('POST', this.server.url + '?' + params, true, this.server.user, this.server.password);
	xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
	xhr.onreadystatechange = function() {
		if (xhr.readyState == XMLHttpRequest.DONE) {
			if (xhr.status == 200) {
				try {
					var response = JSON.parse(xhr.responseText);
					if (response.error)
						throw {message: response.error};
				} catch (e) {
					this.log('Communication error, ' + e.message, 2);
					response = false;
				}
				if (response && callback)
					callback(response);

			} else
				this.log('Server error, ' + xhr.status + ', ' + xhr.responseText, 3);
		}
	}.bind(this);
	xhr.send(params);

}

// Create new room
RoomPeer.prototype.create = function(callback)
{
	this.inExit = false;
	this.serverSend({create: true}, function(response) {

		this.key = response.key;
		this.id = response.id;
		
		this.log('Create, room key : ' + this.key + ', guest id : ' + this.id);
		if (callback)
			callback(this.key, this.id);
		this.trigger('create', this.key, this.id);

		this.checkUpdate();

	}.bind(this));

	return this;
}

RoomPeer.prototype.enter = function(key, callback)
{
	this.inExit = false;
	this.key = key;

	this.serverSend({enter: true}, function(response) {
		this.id = response.id;

		this.log('Enter, guest id : ' + this.id);
		if (callback)
			callback(this.id);
		this.trigger('enter', this.id);

		this.checkUpdate();

	}.bind(this));

	return this;
}

RoomPeer.prototype.checkUpdate = function()
{
	this.serverSend({checkUpdate : true}, function(response) {

		if (response.full) {
			clearTimeout(this.checkUpdateTimeout);
			this.checkUpdateTimeout = null;
			this.log('Room is full');
			this.trigger('full');
			return;
		}

		for (id in response.ids) {
			this.peers[id] = {
				connection: new RTCPeerConnection({ "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }] }),
				channel: null,
				negociation: {
					description : null,
					ices: []
				}
			};
			this.peersLength++;

			this.peers[id].connection.onicecandidate = function(id, e) {
				clearTimeout(this.onicecandidateTimeout[id]);
				if (e.candidate) {
					this.peers[id].negociation.ices.push(e.candidate.toJSON());
					this.onicecandidateTimeout[id] = setTimeout(this.peers[id].connection.onicecandidate.bind(this, id, {candidate: null}), 10);
				}
				else {
					this.serverSend({
						guestId: id,
						negociation: JSON.stringify(this.peers[id].negociation)
					});
				}
			}.bind(this, id);

			if (response.ids[id] == 'offer') {

				this.setChannel(id, this.peers[id].connection.createDataChannel('roompeer.' + this.key + '.' + this.id + '.' + id));

				this.peers[id].connection.createOffer().then(
					function(id, description) {
						this.peers[id].connection.setLocalDescription(this.peers[id].negociation.description = description);
					}.bind(this, id),
					function(error) {
						this.log('Create offer error, ' + error.toString(), 4);
					}.bind(this)
				);
			 } else

			 	this.peers[id].connection.ondatachannel = function(id, e) {
					this.setChannel(id, e.channel);
				}.bind(this, id);

		}

		for (var id in response.negociations) {
			var negociation = JSON.parse(response.negociations[id]);
			this.peers[id].connection.setRemoteDescription(new RTCSessionDescription(negociation.description));

			if (!this.peers[id].channel)

				this.peers[id].connection.createAnswer().then(
					function(id, description) {
						this.peers[id].connection.setLocalDescription(this.peers[id].negociation.description = description);
					}.bind(this, id),
					function(error) {
						this.log('Create answer error, ' + error.toString(), 5);
					}.bind(this)
				);

			for (var i = 0; i < negociation.ices.length; i++)
				this.peers[id].connection.addIceCandidate(new RTCIceCandidate(negociation.ices[i])).then(
					function() {},
					function(err) {
						this.log('Add ice candidate error for guest "' + id + '", ' + err.toString(), 6);
					}.bind(this)
				);

		}

		this.checkUpdateTimeout = setTimeout(this.checkUpdate.bind(this), 1000);

	}.bind(this));
}

RoomPeer.prototype.setChannel = function(id, channel)
{

	this.peers[id].channel = channel;
	channel.onopen = function(id, e) {
		this.log('Guest "' + id + '" is here');
		this.trigger('guest', id);
	}.bind(this, id);
	channel.onclose = function(id, e) {
		delete this.peers[id];
		this.peersLength--;
		if (this.inExit) {
			if (!this.peersLength) {
				this.log('Your are gone away');
				this.trigger('exit');
			}
		} else if (!this.peersLength) {
			this.log('You left because everyone is gone');
			this.trigger('exit');
		} else {
			this.log('Guest "' + id + '" is gone away');
			this.trigger('guestExit', id);
		}
	}.bind(this, id);
	channel.onmessage = function(id, e) {
		this.log('Message from "' + id + '" : ' + e.data);
		this.trigger('message', id, e.data);
	}.bind(this, id)
}

RoomPeer.prototype.send = function(data)
{
	for (id in this.peers)
		if (this.peers[id].channel && this.peers[id].channel.readyState == 'open')
			this.peers[id].channel.send(data);
}

RoomPeer.prototype.full = function()
{
	this.serverSend({full: true});
}

RoomPeer.prototype.exit = function()
{
	this.inExit = true;
	for (id in this.peers)
		this.peers[id].channel.close();
}

RoomPeer.prototype.on = function(name, func)
{
	if (!this.events[name])
		this.events[name] = [];

	this.events[name].push(func);

	return this;
}

RoomPeer.prototype.trigger = function()
{
	var args = Array.prototype.slice.call(arguments);
	var name = args.splice(0, 1);

	if (!this.events[name])
		this.events[name] = [];

	for (var i = 0; i < this.events[name].length; i++)
		this.events[name][i].apply(this, args);

	if (name != 'event')
		this.trigger('event', [name, args]);

	return this;
}