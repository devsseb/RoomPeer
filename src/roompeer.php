<?

	$dbFile = __DIR__ . '/roompeer.db';

	$result = array();

	try {

		function db()
		{
			global $db;
			$data = func_get_args();
			$sql = array_shift($data);
			foreach($data as $i => $d)
				$sql = str_replace('{' . $i . '}', $db->quote($d), $sql);

			$data = $db->query($sql);
			if ($data === false)
				throw new Exception(implode(', ', $db->errorInfo()));

			return $data->fetchAll(PDO::FETCH_ASSOC);
		}

		$db = new PDO('sqlite:' . $dbFile);

		if (!db('SELECT name FROM sqlite_master WHERE type="table" AND name="guest";')) {
			db('CREATE TABLE guest			(key TEXT, id INTEGER PRIMARY KEY AUTOINCREMENT, datetime TEXT	)');
			db('CREATE TABLE guestTransmit	(key TEXT, id INTEGER, guestId INTEGER	)');
			db('CREATE TABLE negociation	(key TEXT, id INTEGER, guestId INTEGER, negociation TEXT,	transmit INTEGER)');
		}

		// Create new peer
		if (array_key_exists('create', $_POST)) {

			$result['key'] = uniqid();

			db('INSERT INTO guest VALUES({0},NULL,strftime("%Y-%m-%d %H:%M:%f", "now"))', $result['key']);
			$result['id'] = $db->lastInsertId();

		} else {

			if (!array_key_exists('key', $_POST))

				throw new Exception('Missing room key');

			$key = $_POST['key'];

			$guests = array();
			foreach (db('SELECT * FROM guest WHERE key = {0}', $key) as $guest)
				$guests[$guest['id']] = $guest['datetime'];

			if (!$guests and array_key_exists('checkUpdate', $_POST))

				$result['full'] = true;

			elseif (!$guests)

				throw new Exception('Room with key "' . $key . '" doesn\'t exists');

			elseif (array_key_exists('full', $_POST)) {

				db('DELETE FROM guest WHERE key = {0}', $key);
				db('DELETE FROM guestTransmit WHERE key = {0}', $key);
				db('DELETE FROM negociation WHERE key = {0}', $key);
				$result['success'] = true;

			// Connect peer
			} elseif (array_key_exists('enter', $_POST)) {

				db('INSERT INTO guest VALUES({0},NULL,strftime("%Y-%m-%d %H:%M:%f", "now"))', $_POST['key']);
				$result['id'] = $db->lastInsertId();

			} else {

				if (!array_key_exists('id', $_POST))

					throw new Exception('Missing guest id');

				if (!array_key_exists($id = $_POST['id'], $guests))

					throw new Exception('Guest id "' . $id . '" doesn\'t registred');


				// Save peer description
				if (array_key_exists('negociation', $_POST)) {

					db('INSERT INTO negociation VALUES({0}, {1}, {2}, {3}, {4})', $key, $id, $_POST['guestId'], $_POST['negociation'], 0);
					$result['success'] = true;

				}

				// Return new description
				elseif (array_key_exists('checkUpdate', $_POST)) {

					$datetime = $guests[$id];

					// Descriptions
					$guestsIdNegociation = array();
					$result['negociations'] = array();
					foreach (db('SELECT id, negociation FROM negociation WHERE key = {0} AND guestId = {1} AND transmit = 0', $key, $id) as $guest) {
						$guestsIdNegociation[] = $db->quote($guest['id']);
						$result['negociations'][$guest['id']] = $guest['negociation'];
					}
					if ($guestsIdNegociation)
						db('UPDATE negociation SET transmit = 1 WHERE key = {0} AND guestId = {1} AND id IN (' . implode(',', $guestsIdNegociation) . ')', $key, $id);


					// Guests id
					$guestsIdTransmit = array();
					$result['ids'] = array();
					foreach (db('SELECT guestId FROM guestTransmit WHERE key = {0} AND id = {1}', $key, $id) as $guest)
						$guestsIdTransmit[$guest['guestId']] = true;

					foreach ($guests as $guestId => $guestDatetime) {

						if ($id == $guestId)
							continue;

						if (!array_key_exists($guestId, $guestsIdTransmit) and ($datetime < $guestDatetime or array_key_exists($guestId, $result['negociations']))) {
							db('INSERT INTO guestTransmit VALUES({0}, {1}, {2})', $key, $id, $guestId);
							$result['ids'][$guestId] = ($datetime < $guestDatetime ? 'offer' : 'answer');
						}
					}

				}
			}
		}

		unset($db);

		if (!$result)
			throw new Exception('Unknown command');

	} catch (Exception $e) {

		$result = array('error' => $e->getMessage());

	}

	exit(json_encode($result));

?>