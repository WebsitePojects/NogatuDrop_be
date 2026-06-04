const DEV_HIERARCHY_PASSWORD = '1';

const AFFILIATION_HIERARCHY_FIXTURE = [
  {
    provincial: {
      name: 'Luna Fernandez',
      email: 'luna.provincial@nogatu.com',
      phone: '+639170010101',
      businessName: 'Luna Provincial Stockist - North Luzon',
      partnerEmail: 'partner.luna.provincial@nogatu.com',
      address: 'MacArthur Highway, San Fernando, Pampanga',
      region: 'Central Luzon',
      warehouse: {
        name: 'Luna North Luzon Hub',
        type: 'region',
        location: 'San Fernando, Pampanga',
        managerName: 'Luna Fernandez',
        managerEmail: 'warehouse.luna@nogatu.com',
        managerPhone: '+639170010111',
      },
    },
    cities: [
      {
        city: {
          name: 'Ash Ramos',
          email: 'ash.caloocan@nogatu.com',
          phone: '+639170010201',
          businessName: 'Ash Caloocan Stockist',
          partnerEmail: 'partner.ash.caloocan@nogatu.com',
          address: 'Caloocan City, Metro Manila',
          region: 'Metro Manila',
          warehouse: {
            name: 'Ash Caloocan City Hub',
            type: 'city',
            location: 'Caloocan City, Metro Manila',
            managerName: 'Ash Ramos',
            managerEmail: 'warehouse.ash@nogatu.com',
            managerPhone: '+639170010211',
          },
        },
        mobile: {
          name: 'Noel Cruz',
          email: 'noel.mobile.ash@nogatu.com',
          phone: '+639170010301',
          address: 'Barangay 28, Caloocan City',
          location: 'Caloocan Mobile Route',
        },
      },
      {
        city: {
          name: 'Ray Villanueva',
          email: 'ray.quezoncity@nogatu.com',
          phone: '+639170010202',
          businessName: 'Ray Quezon City Stockist',
          partnerEmail: 'partner.ray.quezoncity@nogatu.com',
          address: 'Quezon City, Metro Manila',
          region: 'Metro Manila',
          warehouse: {
            name: 'Ray Quezon City Hub',
            type: 'city',
            location: 'Quezon City, Metro Manila',
            managerName: 'Ray Villanueva',
            managerEmail: 'warehouse.ray@nogatu.com',
            managerPhone: '+639170010212',
          },
        },
        mobile: {
          name: 'Ivy Reyes',
          email: 'ivy.mobile.ray@nogatu.com',
          phone: '+639170010302',
          address: 'Cubao, Quezon City',
          location: 'Quezon City Mobile Route',
        },
      },
    ],
  },
  {
    provincial: {
      name: 'Mateo Delgado',
      email: 'mateo.provincial@nogatu.com',
      phone: '+639170020101',
      businessName: 'Mateo Provincial Stockist - East Metro',
      partnerEmail: 'partner.mateo.provincial@nogatu.com',
      address: 'Ortigas Avenue Extension, Cainta, Rizal',
      region: 'Rizal',
      warehouse: {
        name: 'Mateo East Metro Hub',
        type: 'region',
        location: 'Cainta, Rizal',
        managerName: 'Mateo Delgado',
        managerEmail: 'warehouse.mateo@nogatu.com',
        managerPhone: '+639170020111',
      },
    },
    cities: [
      {
        city: {
          name: 'John Navarro',
          email: 'john.valenzuela@nogatu.com',
          phone: '+639170020201',
          businessName: 'John Valenzuela Stockist',
          partnerEmail: 'partner.john.valenzuela@nogatu.com',
          address: 'Valenzuela City, Metro Manila',
          region: 'Metro Manila',
          warehouse: {
            name: 'John Valenzuela City Hub',
            type: 'city',
            location: 'Valenzuela City, Metro Manila',
            managerName: 'John Navarro',
            managerEmail: 'warehouse.john@nogatu.com',
            managerPhone: '+639170020211',
          },
        },
        mobile: {
          name: 'Carlo Perez',
          email: 'carlo.mobile.john@nogatu.com',
          phone: '+639170020301',
          address: 'Paso de Blas, Valenzuela City',
          location: 'Valenzuela Mobile Route',
        },
      },
      {
        city: {
          name: 'Bea Flores',
          email: 'bea.marikina@nogatu.com',
          phone: '+639170020202',
          businessName: 'Bea Marikina Stockist',
          partnerEmail: 'partner.bea.marikina@nogatu.com',
          address: 'Marikina City, Metro Manila',
          region: 'Metro Manila',
          warehouse: {
            name: 'Bea Marikina City Hub',
            type: 'city',
            location: 'Marikina City, Metro Manila',
            managerName: 'Bea Flores',
            managerEmail: 'warehouse.bea@nogatu.com',
            managerPhone: '+639170020212',
          },
        },
        mobile: {
          name: 'Mae Santos',
          email: 'mae.mobile.bea@nogatu.com',
          phone: '+639170020302',
          address: 'Concepcion Uno, Marikina City',
          location: 'Marikina Mobile Route',
        },
      },
    ],
  },
];

function flattenHierarchyAccounts() {
  const accounts = [];

  for (const branch of AFFILIATION_HIERARCHY_FIXTURE) {
    accounts.push({
      role: 'provincial_stockist',
      ...branch.provincial,
    });

    for (const unit of branch.cities) {
      accounts.push({
        role: 'city_stockist',
        parentEmail: branch.provincial.email,
        ...unit.city,
      });
      accounts.push({
        role: 'mobile_stockist',
        parentEmail: unit.city.email,
        ...unit.mobile,
      });
    }
  }

  return accounts;
}

module.exports = {
  DEV_HIERARCHY_PASSWORD,
  AFFILIATION_HIERARCHY_FIXTURE,
  flattenHierarchyAccounts,
};
