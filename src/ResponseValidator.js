// Copyright (c) Brock Allen & Dominick Baier. All rights reserved.
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.

import Log from './Log';
import MetadataService from './MetadataService';
import UserInfoService from './UserInfoService';
import ErrorResponse from './ErrorResponse';
import JoseUtil from './JoseUtil';

const ProtocolClaims = ["nonce", "at_hash", "iat", "nbf", "exp", "aud", "iss", "c_hash"];

export default class ResponseValidator {

    constructor(settings, MetadataServiceCtor = MetadataService, UserInfoServiceCtor = UserInfoService, joseUtil = JoseUtil) {
        if (!settings) {
            Log.error("No settings passed to ResponseValidator");
            throw new Error("settings");
        }

        this._settings = settings;
        this._metadataService = new MetadataServiceCtor(this._settings);
        this._userInfoService = new UserInfoServiceCtor(this._settings);
        this._joseUtil = joseUtil;
    }

    validateSigninResponse(state, response) {
        Log.debug("ResponseValidator.validateSigninResponse");

        return this._processSigninParams(state, response).then(response => {
            Log.debug("state processed");
            return this._validateTokens(state, response).then(response => {
                Log.debug("tokens validated");
                return this._processClaims(response).then(response => {
                    Log.debug("claims processed");
                    return response;
                });
            });
        });
    }

    validateSignoutResponse(state, response) {
        Log.debug("ResponseValidator.validateSignoutResponse");

        if (state.id !== response.state) {
            Log.error("State does not match");
            return Promise.reject(new Error("State does not match"));
        }

        // now that we know the state matches, take the stored data
        // and set it into the response so callers can get their state
        // this is important for both success & error outcomes
        Log.debug("state validated");
        response.state = state.data;

        if (response.error) {
            Log.warn("Response was error", response.error);
            return Promise.reject(new ErrorResponse(response));
        }

        return Promise.resolve(response);
    }

    _processSigninParams(state, response) {
        Log.debug("ResponseValidator._processSigninParams");

        if (state.id !== response.state) {
            Log.error("State does not match");
            return Promise.reject(new Error("State does not match"));
        }
        
        if (!state.client_id) {
            Log.error("No client_id on state");
            return Promise.reject(new Error("No client_id on state"));
        }
        
        if (!state.authority) {
            Log.error("No authority on state");
            return Promise.reject(new Error("No authority on state"));
        }
        
        // this allows the authority to be loaded from the signin state
        if (!this._settings.authority) {
            this._settings.authority = state.authority;
        }
        // ensure we're using the correct authority if the authority is not loaded from signin state
        else if (this._settings.authority && this._settings.authority !== state.authority) {
            Log.error("authority mismatch on settings vs. signin state");
            return Promise.reject(new Error("authority mismatch on settings vs. signin state"));
        }
        // this allows the client_id to be loaded from the signin state
        if (!this._settings.client_id) {
            this._settings.client_id = state.client_id;
        }
        // ensure we're using the correct client_id if the client_id is not loaded from signin state
        else if (this._settings.client_id && this._settings.client_id !== state.client_id) {
            Log.error("client_id mismatch on settings vs. signin state");
            return Promise.reject(new Error("client_id mismatch on settings vs. signin state"));
        }
        
        // now that we know the state matches, take the stored data
        // and set it into the response so callers can get their state
        // this is important for both success & error outcomes
        Log.debug("state validated");
        response.state = state.data;

        if (response.error) {
            Log.warn("Response was error", response.error);
            return Promise.reject(new ErrorResponse(response));
        }

        if (state.nonce && !response.id_token) {
            Log.error("Expecting id_token in response");
            return Promise.reject(new Error("No id_token in response"));
        }

        if (!state.nonce && response.id_token) {
            Log.error("Not expecting id_token in response");
            return Promise.reject(new Error("Unexpected id_token in response"));
        }

        return Promise.resolve(response);
    }

    _processClaims(response) {
        Log.debug("ResponseValidator._processClaims");

        if (response.isOpenIdConnect) {
            Log.debug("response is OIDC, processing claims");

            response.profile = this._filterProtocolClaims(response.profile);

            if (this._settings.loadUserInfo && response.access_token) {
                Log.debug("loading user info");

                return this._userInfoService.getClaims(response.access_token).then(claims => {
                    Log.debug("user info claims received from user info endpoint");

                    if (claims.sub !== response.profile.sub) {
                        Log.error("sub from user info endpoint does not match sub in access_token");
                        return Promise.reject(new Error("sub from user info endpoint does not match sub in access_token"));
                    }

                    response.profile = this._mergeClaims(response.profile, claims);
                    Log.debug("user info claims received, updated profile:", response.profile);

                    return response;
                });
            }
            else {
                Log.debug("not loading user info");
            }
        }
        else {
            Log.debug("response is not OIDC, not processing claims");
        }

        return Promise.resolve(response);
    }

    _mergeClaims(claims1, claims2) {
        var result = Object.assign({}, claims1);

        for (let name in claims2) {
            var values = claims2[name];
            if (!Array.isArray(values)) {
                values = [values];
            }

            for (let value of values) {
                if (!result[name]) {
                    result[name] = value;
                }
                else if (Array.isArray(result[name])) {
                    if (result[name].indexOf(value) < 0) {
                        result[name].push(value);
                    }
                }
                else if (result[name] !== value) {
                    result[name] = [result[name], value];
                }
            }
        }

        return result;
    }

    _filterProtocolClaims(claims) {
        Log.debug("ResponseValidator._filterProtocolClaims, incoming claims:", claims);

        var result = Object.assign({}, claims);

        if (this._settings._filterProtocolClaims) {
            ProtocolClaims.forEach(type => {
                delete result[type];
            });

            Log.debug("protocol claims filtered", result);
        }
        else {
            Log.debug("protocol claims not filtered")
        }

        return result;
    }

    _validateTokens(state, response) {
        Log.debug("ResponseValidator._validateTokens");

        if (response.id_token) {

            if (response.access_token) {
                Log.debug("Validating id_token and access_token");
                return this._validateIdTokenAndAccessToken(state, response);
            }

            Log.debug("Validating id_token");
            return this._validateIdToken(state, response);
        }

        Log.debug("No id_token to validate");
        return Promise.resolve(response);
    }

    _validateIdTokenAndAccessToken(state, response) {
        Log.debug("ResponseValidator._validateIdTokenAndAccessToken");

        return this._validateIdToken(state, response).then(response => {
            return this._validateAccessToken(response);
        });
    }

    _validateIdToken(state, response) {
        Log.debug("ResponseValidator._validateIdToken");

        if (!state.nonce) {
            Log.error("No nonce on state");
            return Promise.reject(new Error("No nonce on state"));
        }
        
        let jwt = this._joseUtil.parseJwt(response.id_token);
        if (!jwt || !jwt.header || !jwt.payload) {
            Log.error("Failed to parse id_token", jwt);
            return Promise.reject(new Error("Failed to parse id_token"));
        }

        if (state.nonce !== jwt.payload.nonce) {
            Log.error("Invalid nonce in id_token");
            return Promise.reject(new Error("Invalid nonce in id_token"));
        }

        var kid = jwt.header.kid;

        return this._metadataService.getIssuer().then(issuer => {
            Log.debug("Received issuer");

            return this._metadataService.getSigningKeys().then(keys => {
                if (!keys) {
                    Log.error("No signing keys from metadata");
                    return Promise.reject(new Error("No signing keys from metadata"));
                }

                Log.debug("Received signing keys");
                let key;
                if (!kid) {
                    keys = this._filterByAlg(keys, jwt.header.alg);

                    if (keys.length > 1) {
                        Log.error("No kid found in id_token and more than one key found in metadata");
                        return Promise.reject(new Error("No kid found in id_token and more than one key found in metadata"));
                    } 
                    else {
                        // kid is mandatory only when there are multiple keys in the referenced JWK Set document
                        // see http://openid.net/specs/openid-connect-core-1_0.html#Signing
                        key = keys[0];
                    }
                }
                else {
                    key = keys.filter(key => {
                        return key.kid === kid;
                    })[0];
                }

                if (!key) {
                    Log.error("No key matching kid or alg found in signing keys");
                    return Promise.reject(new Error("No key matching kid or alg found in signing keys"));
                }

                let audience = state.client_id;
                
                let clockSkewInSeconds = this._settings.clockSkew;
                Log.debug("Validaing JWT; using clock skew (in seconds) of: ", clockSkewInSeconds);

                return this._joseUtil.validateJwt(response.id_token, key, issuer, audience, clockSkewInSeconds).then(()=>{
                    Log.debug("JWT validation successful");
                    
                    if (!jwt.payload.sub) {
                        Log.error("No sub present in id_token");
                        return Promise.reject(new Error("No sub present in id_token"));
                    }

                    response.profile = jwt.payload;
                    
                    return response;
                });
            });
        });
    }

    _filterByAlg(keys, alg){
        Log.debug("ResponseValidator._filterByAlg", alg);

        var kty = null;
        if (alg.startsWith("RS")) {
            kty = "RSA";
        }
        else if (alg.startsWith("PS")) {
            kty = "PS";
        }
        else if (alg.startsWith("ES")) {
            kty = "EC";
        }
        else {
            Log.debug("alg not supported: ", alg);
            return [];
        }
        
        Log.debug("Looking for keys that match kty: ", kty);

        keys = keys.filter(key => {
            return key.kty === kty;
        });

        Log.debug("Number of keys that match kty: ", kty, keys.length);

        return keys;
    }

    _validateAccessToken(response) {
        Log.debug("ResponseValidator._validateAccessToken");

        if (!response.profile) {
            Log.error("No profile loaded from id_token");
            return Promise.reject(new Error("No profile loaded from id_token"));
        }

        if (!response.profile.at_hash) {
            Log.error("No at_hash in id_token");
            return Promise.reject(new Error("No at_hash in id_token"));
        }

        if (!response.id_token) {
            Log.error("No id_token");
            return Promise.reject(new Error("No id_token"));
        }

        let jwt = this._joseUtil.parseJwt(response.id_token);
        if (!jwt || !jwt.header) {
            Log.error("Failed to parse id_token", jwt);
            return Promise.reject(new Error("Failed to parse id_token"));
        }

        var hashAlg = jwt.header.alg;
        if (!hashAlg || hashAlg.length !== 5) {
            Log.error("Unsupported alg:", hashAlg);
            return Promise.reject(new Error("Unsupported alg: " + hashAlg));
        }

        var hashBits = hashAlg.substr(2, 3);
        if (!hashBits) {
            Log.error("Unsupported alg:", hashAlg, hashBits);
            return Promise.reject(new Error("Unsupported alg: " + hashAlg));
        }

        hashBits = parseInt(hashBits);
        if (hashBits !== 256 && hashBits !== 384 && hashBits !== 512) {
            Log.error("Unsupported alg:", hashAlg, hashBits);
            return Promise.reject(new Error("Unsupported alg: " + hashAlg));
        }

        let sha = "sha" + hashBits;
        var hash = this._joseUtil.hashString(response.access_token, sha);
        if (!hash) {
            Log.error("access_token hash failed:", sha);
            return Promise.reject(new Error("Failed to validate at_hash"));
        }

        var left = hash.substr(0, hash.length / 2);
        var left_b64u = this._joseUtil.hexToBase64Url(left);
        if (left_b64u !== response.profile.at_hash) {
            Log.error("Failed to validate at_hash", left_b64u, response.profile.at_hash);
            return Promise.reject(new Error("Failed to validate at_hash"));
        }

        return Promise.resolve(response);
    }
}