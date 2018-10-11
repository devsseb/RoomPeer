/** 
 * RoomPeer v1.0.2
 * Use Webrtc to create peer connections
 * https://github.com/devsseb/RoomPeer
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

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
	this.total = 0;
	this.maxsize = 65536;
	this.locked = false;
	this.currentMessage = {};
	this.events = {
		ready: [],
		create: [],
		enter: [],
		guest: [],
		guestExit: [],
		lock: [],
		exit: [],
		message : [],
		error: [],
		event: []
	};
	for (var name in this.events)
		if (options['on' + name])
			this.on(name, options['on' + name]);

	this.computeStunServers(options.stunServers || 'https://gist.githubusercontent.com/mondain/b0ec1cf5f60ae726202e/raw/0d0a751880b7ab2a0cd4a8e606316074cf9eeb8e/public-stun-list.txt');
}

RoomPeer.prototype.computeStunServers = function(servers)
{
	var computed = true;
	if (typeof servers != 'object') {
		computed = false;

		if (typeof servers == 'string') {
			if (servers.substr(0, 4) != 'http')
				this.computeStunServers([servers]);
			else {
				const req = new XMLHttpRequest();
    			req.open('GET', servers); 
				req.onreadystatechange = function(e) {
	    			if (e.target.readyState === XMLHttpRequest.DONE) {
						if (e.target.status === 200) {
							servers = e.target.responseText.split("\n");
							this.computeStunServers(servers);
						} else
							this.log('Fail to retrieve stun servers', 8);
	    			}
    			}.bind(this)
				req.send();
			}
		}
	}

	if (computed) {

		var randomIndex = Math.floor(Math.random() * Math.floor(servers.length));

		this.stunserver = servers[randomIndex].replace('stun:', '');

		setTimeout(function() {
			this.log('Ready with stun server stun:' + this.stunserver);
			this.trigger('ready', this.stunserver);
		}.bind(this));
	}


}

RoomPeer.prototype.log = function(message, errorId)
{
		if (errorId) {
			if (this.debug)
				console.error('[RoomPeer' + (this.name ? ' "' + this.name + '"' : '') + ' error ' + errorId + '] ' + message);
			this.trigger('error', message, errorId);
		}
		else if (this.debug)
			console.log('[RoomPeer' + (this.name ? ' "' + this.name + '"' : '') + '] ' + message);	

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
		this.total = 1;
		
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
		this.total = response.total;

		this.log('Enter, guest id : ' + this.id);
		if (callback)
			callback(this.id, this.total);
		this.trigger('enter', this.id, this.total);

		this.checkUpdate();

	}.bind(this));

	return this;
}

RoomPeer.prototype.checkUpdate = function()
{
	this.serverSend({checkUpdate : true}, function(response) {

		if (response.lock) {
			clearTimeout(this.checkUpdateTimeout);
			this.checkUpdateTimeout = null;
			this.locked = true;
			this.log('Room is locked (' +  this.total + ' guest' + (this.total > 1 ? 's' : '') + ')');
			this.trigger('lock', this.total);
			return;
		}

		this.total = response.total;

		for (var id in response.ids) {
			this.peers[id] = {
				connection: new RTCPeerConnection({ "iceServers": [{ "urls": ["stun:stun.services.mozilla.com"] }] }),
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
		this.currentMessage[id] = '';
		this.log('Guest "' + id + '" is here');
		this.trigger('guest', id, this.total);
	}.bind(this, id);
	channel.onclose = function(id, e) {
		delete this.peers[id];
		this.peersLength--;
		this.total--;
		if (this.inExit) {
			if (!this.peersLength) {
				this.log('Your are gone away');
				this.trigger('exit');
			}
		} else if (!this.peersLength && this.locked) {
			this.log('You left because everyone is gone');
			this.trigger('exit');
		} else {
			this.log('Guest "' + id + '" is gone away');
			this.trigger('guestExit', id, this.total);
		}
	}.bind(this, id);
	channel.onmessage = function(id, e) {

		var index = e.data.indexOf('.');
		var count = e.data.indexOf('.', index + 1);
		var type = e.data.indexOf('.', count + 1);
		this.currentMessage[id]+= e.data.substr(type + 1);
		type = e.data.substring(count + 1, type);
		count = e.data.substring(index + 1, count);
		index = e.data.substring(0, index);

		if (index == count) {
			this.log('Message from "' + id + '" : ' + (this.currentMessage[id].length > 50 ? this.currentMessage[id].substr(0,50) + '...' : this.currentMessage[id]));

			if (type != 'string')
				this.currentMessage[id] = JSON.parse(this.currentMessage[id]);

			this.trigger('message', id, this.currentMessage[id]);
			this.currentMessage[id] = '';
		}
	}.bind(this, id)
	channel.onerror = function(id, e) {
		this.log('Channel error from "' + id + '" : ' + e.message, 7);
	}.bind(this, id)
}

RoomPeer.prototype.send = function(data)
{
	var type = 'string';
	if (typeof data != type) {
		type = typeof data;
		data = JSON.stringify(data);
	}

	for (var id in this.peers)
		if (this.peers[id].channel && this.peers[id].channel.readyState == 'open') {
			var count = Math.ceil(data.length / this.maxsize);
			for (var i = 0; i < count; i++)
				this.peers[id].channel.send((i + 1) + '.' + count + '.' + type + '.' + data.substr(i * this.maxsize, this.maxsize));
		}
}

RoomPeer.prototype.lock = function()
{
	this.serverSend({lock: true});
}

RoomPeer.prototype.exit = function()
{
	this.inExit = true;
	for (var id in this.peers)
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