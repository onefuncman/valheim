import { Names, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Duration } from 'aws-cdk-lib';


const VALHEIM_PORT = 2456;
const VALHEIM_SAVE_DIR = '/root/.config/unity3d/IronGate/Valheim';

const DEFAULT_VCPU = 1024;
const DEFAULT_MEMORY = 8192;
const DEFAULT_IMAGE = 'raykrueger/valheim';
const DEFAULT_SERVER_PASSWORD_SECRET_NAME = 'ValheimServerPassword';

export interface ValheimServerProps {
  /**
   * Where is the server password secret stored?
   *
   * Optional. If not defined a random password will be generated in SecretsManager at `generatedServerPasswordSecretName`.
   */
  readonly serverPasswordSecret?: secretsmanager.ISecret;

  /**
   * If we are generating a random password, what name will it be stored under in Secrets Manager?
   * Note that this value is not used if `serverPasswordSecret` is given.
   *
   * @default DEFAULT_SERVER_PASSWORD_SECRET_NAME
   */
  readonly generatedServerPasswordSecretName?: string;

  /**
   * Do we want to enable Cloudwatch Container Insights, and incur additional cost?
   *
   * @default false
   */
  readonly containerInsights?: boolean;

  /**
   * Provide an existing VPC to deploy into. If none is given a default `ec2.VPC` will be created.
   */
  readonly vpc?: ec2.IVpc;

  /**
   * vCpu amout to be granted to ECS Fargate task.
   *
   * @see https://aws.amazon.com/fargate/pricing/
   * @default DEFAULT_VCPU
   */
  readonly cpu?: number;

  /**
   * Memory limit in 1024 incrmements.
   * @see https://aws.amazon.com/fargate/prici/
   * @default DEFAULT_VCPU
   */
  readonly memoryLimitMiB?: number;

  /**
   * Logging driver to use. The Cloudwatch logging driver will incur addtional costs.
   *
   * @example logging: new ecs.AwsLogDriver({ streamPrefix: 'EventDemo' })
   *
   * @default undefined
   */
  readonly logging?: ecs.LogDriver;

  /**
   * The container image to run.
   * @see https://hub.docker.com/r/raykrueger/valheim
   * @default DEFAULT_IMAGE
   */
  readonly image?: string;

  dnsConfig?: Route53DomainProps;
}

/**
 * Builds a ValheimServer, running on ECS Fargate. This is designed to run as
 * cheaply as possible, which means some availability and reliability has been
 * sacrificed.
 *
 * Default configuration:
 *    Single AZ with a Single Public Subnet
 *    Fargate Spot capacity provider
 *    EFS General performance file system for storage
 *    NLB for static IP and DNS
 */
export class ValheimServer extends Construct {

  //Offer properties for things we may have created
  readonly vpc: ec2.IVpc;
  readonly serverPasswordSecret: secretsmanager.ISecret;
  readonly cpu: number;
  readonly memoryLimitMiB: number;
  readonly image: string;
  readonly generatedServerPasswordSecretName: string;
  readonly containerInsights: boolean;
  readonly logging: ecs.LogDriver | undefined;

  constructor(scope: Construct, id: string, props: ValheimServerProps = {}) {
    super(scope, id);

    //Setup some defaults
    /**
     * Default VPC is designed to make this as cheap as possible.
     * We are trading off reliability for cost by making a single AZ VPC.
     * The Single AZ has a single Public subnet.
     */
    this.vpc = props.vpc || new ec2.Vpc(this, 'VPC', {
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    this.cpu = props.cpu || DEFAULT_VCPU;
    this.memoryLimitMiB = props.memoryLimitMiB || DEFAULT_MEMORY;
    this.image = props.image || DEFAULT_IMAGE;
    this.generatedServerPasswordSecretName = props.generatedServerPasswordSecretName || DEFAULT_SERVER_PASSWORD_SECRET_NAME;
    this.containerInsights = !!props.containerInsights;
    this.logging = props.logging;

    this.serverPasswordSecret = props.serverPasswordSecret || new secretsmanager.Secret(this, 'GeneratedServerPasswordSecret', {
      secretName: props.generatedServerPasswordSecretName,
      generateSecretString: {
        passwordLength: 8,
      },
    });

    //Define our EFS file system
    const fs = new efs.FileSystem(this, 'ValheimFileSystem', {
      vpc: this.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: RemovalPolicy.RETAIN,
      enableAutomaticBackups: true
    });
    fs.addAccessPoint('AccessPoint');
    fs.connections.allowDefaultPortInternally();

    //Create our ECS Cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      containerInsights: this.containerInsights,
      enableFargateCapacityProviders: true,
    });

    new PublicIPSupport(this, 'PublicIPSupport', {
      cluster: cluster,
      dnsConfig: props.dnsConfig
    });

    // see https://github.com/aws/aws-cdk/issues/15366
    // Add back the old method of specifying capacity providers
    const cfnCluster = cluster.node.defaultChild as ecs.CfnCluster;
    cfnCluster.capacityProviders = ['FARGATE', 'FARGATE_SPOT'];

    //Create our ECS TaskDefinition using our cpu and memory limits
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: this.cpu,
      memoryLimitMiB: this.memoryLimitMiB,
    });

    //Add our EFS volume to the task definition so it can be used as a mount point later
    taskDef.addVolume({
      name: 'efsVolume',
      efsVolumeConfiguration: {
        fileSystemId: fs.fileSystemId,
      },
    });

    /**
         * Add our container definition, map the VALHEIM_PORT, and setup our
         * mount point so that Valheim saves our world to EFS
         */
    const containerDef = taskDef.addContainer('server', {
      image: ecs.ContainerImage.fromRegistry(this.image),
      logging: this.logging,
      secrets: {
        SERVER_PASSWORD: ecs.Secret.fromSecretsManager(this.serverPasswordSecret),
      },
    });
    containerDef.addMountPoints({ sourceVolume: 'efsVolume', containerPath: VALHEIM_SAVE_DIR, readOnly: false });
    containerDef.addPortMappings({ containerPort: VALHEIM_PORT, hostPort: VALHEIM_PORT, protocol: ecs.Protocol.UDP });
    containerDef.addPortMappings({ containerPort: VALHEIM_PORT+1, hostPort: VALHEIM_PORT+1, protocol: ecs.Protocol.UDP });

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(VALHEIM_PORT));
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(VALHEIM_PORT+1));

    //Super important! Tell EFS to allow this SecurityGroup in to access the filesystem
    //Note that fs.connections.allowDefaultPortFrom(cluster) did not work here, I'll look into that later.
    fs.connections.allowDefaultPortFrom(securityGroup);

    /**
         * Now we create our Fargate based service to run the game server
         * FargatePlatformVerssion VERSION1_4 is required here!
         * LATEST is not yet 1.4 at the time of thi writing
         */
    new ecs.FargateService(this, 'Service', {
      cluster: cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [securityGroup],
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      assignPublicIp: true,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 2,
        },
        {
          capacityProvider: 'FARGATE',
          weight: 1,
        },
      ],
    });
  }
}


export interface Route53DomainProps {
  assumedRole?: string;
  hostzedZone: string;
  domainName: string;
}

export interface PublicIPSupportProps {
  cluster: ecs.ICluster;
  dnsConfig?: Route53DomainProps;
}

export class PublicIPSupport extends Construct {

  constructor(scope: Construct, id: string, props: PublicIPSupportProps) {
    super(scope, id);

    const cluster = props.cluster;

    const func = new lambda.Function(this, 'PublicIPManager', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'functions/public_ip_manager')),
      timeout: Duration.seconds(10),
      logRetention: RetentionDays.TWO_WEEKS,
      initialPolicy: [
        new PolicyStatement({
          actions: ['ec2:DescribeNetworkInterfaces'],
          resources: ['*']
        }),
      ]
    });

    if (props.dnsConfig) {
      func.addEnvironment("DNS_HOSTED_ZONE", props.dnsConfig.hostzedZone)
      func.addEnvironment("DNS_DOMAIN", props.dnsConfig.domainName)

      /**
       * If we are assume a role, we just need those permissions.
       * If we are not assuming a role, we need permissions for route53
       */
      if (props.dnsConfig.assumedRole) {
        func.addEnvironment("DNS_ASSUMED_ROLE", props.dnsConfig.assumedRole)
        func.addToRolePolicy(
          new PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [props.dnsConfig.assumedRole]
          }),
        );
      } else {
        func.addToRolePolicy(
          new PolicyStatement({
            actions: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets'],
            resources: [props.dnsConfig?.hostzedZone]
          })
        )
      }
    }

    new events.Rule(this, 'ServiceRule', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['RUNNING'],
        }
      },
      targets: [new targets.LambdaFunction(func)]
    });

  }
}